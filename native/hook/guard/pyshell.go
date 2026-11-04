package guard

// Python-compatible text helpers. The policy this package ports was written
// against Python's shlex, pathlib, os.path and str semantics; decisions must
// stay identical, so the pieces the policy leans on are reproduced here
// instead of approximated with Go's near neighbours.

import (
	"errors"
	"os"
	"os/user"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	errNoClosingQuote = errors.New("No closing quotation")
	errNoEscaped      = errors.New("No escaped character")
)

const eofRune rune = -1

// shlexer is shlex.shlex(posix=True, whitespace_split=True) reading a string.
type shlexer struct {
	src        []rune
	pos        int
	punct      string // punctuation_chars
	whitespace string
	comments   bool // commenters == "#"
	pushed     []rune
	done       bool
}

func newShlexer(s, punct, whitespace string, comments bool) *shlexer {
	return &shlexer{src: []rune(s), punct: punct, whitespace: whitespace, comments: comments}
}

func (l *shlexer) read() rune {
	if len(l.pushed) > 0 {
		c := l.pushed[len(l.pushed)-1]
		l.pushed = l.pushed[:len(l.pushed)-1]
		return c
	}
	if l.pos >= len(l.src) {
		return eofRune
	}
	c := l.src[l.pos]
	l.pos++
	return c
}

func (l *shlexer) readline() {
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		l.pos++
		if c == '\n' {
			return
		}
	}
}

func (l *shlexer) isWS(c rune) bool    { return strings.ContainsRune(l.whitespace, c) }
func (l *shlexer) isPunct(c rune) bool { return strings.ContainsRune(l.punct, c) }
func isQuote(c rune) bool              { return c == '\'' || c == '"' }

// next returns the next token; ok is false at end of input.
func (l *shlexer) next() (tok string, ok bool, err error) {
	if l.done {
		return "", false, nil
	}
	var token []rune
	quoted := false
	state := ' '
	escaped := ' '
	emit := func() (string, bool, error) { return string(token), true, nil }
	for {
		c := l.read()
		switch {
		case state == ' ':
			switch {
			case c == eofRune:
				l.done = true
				return "", false, nil
			case l.isWS(c):
				if len(token) > 0 || quoted {
					return emit()
				}
			case l.comments && c == '#':
				l.readline()
			case c == '\\':
				escaped = 'a'
				state = c
			case l.isPunct(c):
				token = append(token, c)
				state = 'c'
			case isQuote(c):
				state = c
			default:
				token = append(token, c)
				state = 'a'
			}
		case isQuote(state):
			quoted = true
			switch {
			case c == eofRune:
				return "", false, errNoClosingQuote
			case c == state:
				state = 'a'
			case c == '\\' && state == '"':
				escaped = state
				state = c
			default:
				token = append(token, c)
			}
		case state == '\\':
			if c == eofRune {
				return "", false, errNoEscaped
			}
			if isQuote(escaped) && c != state && c != escaped {
				token = append(token, state)
			}
			token = append(token, c)
			state = escaped
		default: // 'a' (word) or 'c' (punctuation run)
			switch {
			case c == eofRune:
				l.done = true
				if len(token) == 0 && !quoted {
					return "", false, nil
				}
				return emit()
			case l.isWS(c):
				state = ' '
				if len(token) > 0 || quoted {
					return emit()
				}
			case l.comments && c == '#':
				l.readline()
				state = ' '
				if len(token) > 0 || quoted {
					return emit()
				}
			case state == 'c':
				if l.isPunct(c) {
					token = append(token, c)
				} else {
					if !l.isWS(c) {
						l.pushed = append(l.pushed, c)
					}
					return emit()
				}
			case isQuote(c):
				state = c
			case c == '\\':
				escaped = 'a'
				state = c
			case l.isPunct(c):
				l.pushed = append(l.pushed, c)
				state = ' '
				if len(token) > 0 || quoted {
					return emit()
				}
			default:
				token = append(token, c)
			}
		}
	}
}

func (l *shlexer) all() ([]string, error) {
	var out []string
	for {
		t, ok, err := l.next()
		if err != nil {
			return nil, err
		}
		if !ok {
			return out, nil
		}
		out = append(out, t)
	}
}

// shlexSplit is shlex.split(s): POSIX words, no comments, no punctuation.
func shlexSplit(s string) ([]string, error) {
	return newShlexer(s, "", " \t\r\n", false).all()
}

const shlexSafe = "%+,-./0123456789:=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"

func shlexQuote(s string) string {
	if s == "" {
		return "''"
	}
	safe := true
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(shlexSafe, s[i]) < 0 {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// shlexJoin is shlex.join: the text normalize_segment hands to the regexes.
func shlexJoin(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shlexQuote(a)
	}
	return strings.Join(parts, " ")
}

// pathName is PurePosixPath(s).name: empty and "." components vanish.
func pathName(s string) string {
	name := ""
	for _, part := range strings.Split(s, "/") {
		if part != "" && part != "." {
			name = part
		}
	}
	return name
}

// exeName is Path(s).name.lower(), the spelling every executable test uses.
func exeName(s string) string { return pyLower(pathName(s)) }

func pyLower(s string) string {
	if !strings.ContainsRune(s, 'İ') {
		return strings.ToLower(s)
	}
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i̇"))
}

// pyCasefold is str.casefold() for the letters that fold to something other
// than their lowercase form and could spell a wrapper name.
func pyCasefold(s string) string {
	s = pyLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == 'ſ':
			b.WriteByte('s')
		case r == 'ß' || r == 'ẞ':
			b.WriteString("ss")
		case r >= 0xFB00 && r <= 0xFB06:
			b.WriteString([]string{"ff", "fi", "fl", "ffi", "ffl", "st", "st"}[r-0xFB00])
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// pyIsSpace is str.isspace() per character.
func pyIsSpace(r rune) bool { return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f) }

func pyFields(s string) []string { return strings.FieldsFunc(s, pyIsSpace) }
func pyStrip(s string) string    { return strings.TrimFunc(s, pyIsSpace) }

func pyIsWord(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r) }

// regexText rewrites s so Go's ASCII-only \s, \w and \b judge it the way
// Python's Unicode-aware re judges the original: Unicode whitespace becomes a
// space and other non-ASCII word characters become "_". With fold set, the
// characters that re.IGNORECASE equates with ASCII letters become those
// letters. Only used for yes/no searches, so offsets do not matter.
func regexText(s string, fold bool) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf || s[i] == 0x0b || (s[i] >= 0x1c && s[i] <= 0x1f) {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < utf8.RuneSelf && !(r == 0x0b || (r >= 0x1c && r <= 0x1f)):
			b.WriteRune(r)
		case pyIsSpace(r):
			b.WriteByte(' ')
		case fold && (r == 'İ' || r == 'ı'):
			b.WriteByte('i')
		case fold && r == 'ſ':
			b.WriteByte('s')
		case fold && r == 'K':
			b.WriteByte('k')
		case pyIsWord(r):
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// homeDir is os.path.expanduser("~")'s home: $HOME, else the passwd entry.
func homeDir() (string, bool) {
	if h, ok := os.LookupEnv("HOME"); ok {
		return h, true
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir, true
	}
	return "", false
}

// expandUser is os.path.expanduser.
func expandUser(p string) string {
	if !strings.HasPrefix(p, "~") {
		return p
	}
	i := strings.IndexByte(p[1:], '/')
	if i < 0 {
		i = len(p)
	} else {
		i++
	}
	var home string
	if i == 1 {
		h, ok := homeDir()
		if !ok {
			return p
		}
		home = h
	} else {
		u, err := user.Lookup(p[1:i])
		if err != nil {
			return p
		}
		home = u.HomeDir
	}
	home = strings.TrimRight(home, "/")
	if out := home + p[i:]; out != "" {
		return out
	}
	return "/"
}

// normPath is os.path.normpath.
func normPath(p string) string {
	if p == "" {
		return "."
	}
	initial := ""
	if strings.HasPrefix(p, "/") {
		initial = "/"
		if strings.HasPrefix(p, "//") && !strings.HasPrefix(p, "///") {
			initial = "//"
		}
	}
	var comps []string
	for _, c := range strings.Split(p, "/") {
		if c == "" || c == "." {
			continue
		}
		if c != ".." || (initial == "" && len(comps) == 0) || (len(comps) > 0 && comps[len(comps)-1] == "..") {
			comps = append(comps, c)
		} else if len(comps) > 0 {
			comps = comps[:len(comps)-1]
		}
	}
	if out := initial + strings.Join(comps, "/"); out != "" {
		return out
	}
	return "."
}

// joinPath is os.path.join(a, b).
func joinPath(a, b string) string {
	switch {
	case strings.HasPrefix(b, "/") || a == "":
		return b
	case strings.HasSuffix(a, "/"):
		return a + b
	}
	return a + "/" + b
}

// dirName is os.path.dirname.
func dirName(p string) string {
	head := p[:strings.LastIndexByte(p, '/')+1]
	if head != "" && strings.Trim(head, "/") != "" {
		head = strings.TrimRight(head, "/")
	}
	return head
}

// under reports whether path is root or inside it.
func under(path, root string) bool {
	return path == root || strings.HasPrefix(path, strings.TrimRight(root, "/")+"/")
}

// pyUpper is str.upper() for the letters whose uppercase form is ASCII text.
func pyUpper(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == 'ß':
			b.WriteString("SS")
		case r >= 0xFB00 && r <= 0xFB06:
			b.WriteString([]string{"FF", "FI", "FL", "FFI", "FFL", "ST", "ST"}[r-0xFB00])
		default:
			b.WriteString(strings.ToUpper(string(r)))
		}
	}
	return b.String()
}
