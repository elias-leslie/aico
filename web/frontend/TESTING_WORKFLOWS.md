# A-Term - Testing Workflows

Complete checklist for testing all aterm workflows and behaviors.

---

## Core Concepts Reference

| Concept | Description |
|---------|-------------|
| **Pane** | Container holding 1-2 sessions. Max 6 panes on ultrawide layouts. |
| **Project Pane** | Has shell + claude sessions, mode toggle |
| **Ad-Hoc Pane** | Shell-only, no project association |
| **Session** | Actual tmux-backed aterm instance |
| **Mode** | Shell or Claude (project panes only) |

---

## 1. LAYOUT MODES

### Single Mode (Default)

- [ ] One aterm fills viewport with unified header at top
- [ ] A-Term switcher dropdown in header shows all panes
- [ ] Layout button visible (shows grid option)
- [ ] Mode toggle visible for project panes
- [ ] Settings, upload, and action buttons accessible

### Grid Mode (2x2)

- [ ] Click layout button → grid mode activates
- [ ] Up to 4 aterms display in 2x2 grid
- [ ] Each pane has its own header with controls
- [ ] Click pane → that pane becomes active (border highlight)
- [ ] Keyboard input goes to active pane only
- [ ] Layout button in each pane header → can return to single mode

### Grid Mode - Drag & Drop

- [ ] Drag pane header → pane becomes draggable
- [ ] Drop on another pane position → panes swap positions
- [ ] Order persists after page reload
- [ ] Visual feedback during drag (shadow, opacity)

### Layout Mode Restrictions

- [ ] Grid mode hidden on viewports < 1280px
- [ ] Grid mode hidden on mobile devices
- [ ] Switching to single mode shows previously active pane

---

## 2. ATERM CREATION

### A-Term Manager Modal

- [ ] Ctrl+T opens A-Term Manager modal
- [ ] Click + button opens A-Term Manager modal
- [ ] Modal shows list of all projects
- [ ] Modal shows "New Ad-Hoc A-Term" option
- [ ] Each project shows count of open panes (e.g., "1 open")
- [ ] Click outside modal closes it
- [ ] Esc key closes modal

### Create Project A-Term

- [ ] Click project with no existing pane → new pane created
- [ ] New pane opens in project's root directory
- [ ] Default mode is shell
- [ ] Mode toggle is visible and functional
- [ ] A-Term switcher shows project name

### Create Project A-Term (Existing Pane)

- [ ] Click project that already has pane open
- [ ] Navigates to existing pane (no duplicate created)
- [ ] Project shows "1 open" badge in modal

### Create Ad-Hoc A-Term

- [ ] Click "New Ad-Hoc A-Term" → new pane created
- [ ] Pane named "Ad-Hoc A-Term"
- [ ] Shell mode only (no mode toggle)
- [ ] Second ad-hoc named "Ad-Hoc A-Term [2]"
- [ ] Third ad-hoc named "Ad-Hoc A-Term [3]"

### Pane Limit (viewport-dependent)

- [ ] With viewport pane limit reached, + buttons are disabled
- [ ] A-Term Manager shows "at limit" state
- [ ] Cannot exceed viewport capacity (4 standard, 6 ultrawide)

---

## 3. ATERM SWITCHER (Dropdown)

### Empty State

- [ ] With 0 panes, dropdown shows "No aterms open"

### With A-Terms

- [ ] Click dropdown → opens pane list
- [ ] All panes listed with names
- [ ] Project panes show mode indicator (shell/claude)
- [ ] Active pane highlighted with checkmark
- [ ] Click pane in list → switches to that pane
- [ ] Click outside → closes dropdown

---

## 4. MODE TOGGLE (Shell ↔ Claude)

### Basic Toggle

- [ ] Mode toggle only visible for project panes
- [ ] Mode toggle NOT visible for ad-hoc panes
- [ ] Shell mode: dim aterm icon
- [ ] Claude mode: glowing sparkles with animation

### Shell → Claude

- [ ] Click toggle in shell mode
- [ ] Spinner appears on button
- [ ] Claude starts in background
- [ ] Mode switches when Claude confirmed running
- [ ] Prompt cleaner button appears (sparkles icon)

### Claude → Shell

- [ ] Click toggle in claude mode
- [ ] Mode switches immediately (no spinner)
- [ ] Prompt cleaner button disappears

### Toggle During Loading

- [ ] Click toggle while spinner showing
- [ ] Click is ignored (button disabled)

### Toggle After Close All

- [ ] Close All A-Terms
- [ ] Create new project aterm
- [ ] Click mode toggle
- [ ] Should work on FIRST click (no stale state)
- [ ] No need to click 2-3 times

---

## 5. PANE OPERATIONS

### Reset Single Pane

- [ ] Click reset button (RefreshCw icon) on pane
- [ ] A-Term history cleared
- [ ] Session stays alive
- [ ] Shell shows fresh prompt
- [ ] Claude session resets if in claude mode

### Close Single Pane

- [ ] Click X on pane header
- [ ] Confirmation dialog appears
- [ ] Confirm → pane deleted
- [ ] Cancel → pane remains

### Close Last Pane

- [ ] Close the only remaining pane
- [ ] New ad-hoc pane auto-created
- [ ] Dropdown shows the new ad-hoc aterm

### Reset All

- [ ] Click menu → "Reset All A-Terms"
- [ ] Confirmation dialog appears
- [ ] Confirm → all sessions cleared
- [ ] All sessions remain alive (just cleared)

### Close All

- [ ] Click menu → "Close All A-Terms"
- [ ] Confirmation dialog appears
- [ ] Confirm → all panes deleted
- [ ] New ad-hoc pane auto-created
- [ ] Dropdown shows "Ad-Hoc A-Term" (not empty "A-Term")
- [ ] All Claude processes terminated

---

## 6. PANE SWAPPING (Grid Mode)

- [ ] In grid mode, swap dropdown visible in pane header
- [ ] Click swap dropdown → shows list of other panes
- [ ] Select target pane → positions swap
- [ ] Swap order persists after reload
- [ ] Swap dropdown not visible in single mode

---

## 7. FILE UPLOAD

### Via Button

- [ ] Click paperclip icon → file picker opens
- [ ] Select supported file type
- [ ] Upload starts, progress toast appears
- [ ] Progress shows 0-100%
- [ ] Upload complete → file path inserted at cursor
- [ ] Path appears in active aterm

### Via Drag-Drop

- [ ] Drag file over aterm area
- [ ] Drop zone overlay appears
- [ ] Drop file → upload starts
- [ ] Same progress/completion as button upload

### Upload Errors

- [ ] Upload unsupported file type → error toast
- [ ] Network error during upload → error toast with message
- [ ] Error toast dismissible

### Supported File Types

- [ ] Images (jpg, png, gif, etc.) upload successfully
- [ ] .md files upload successfully
- [ ] .txt files upload successfully
- [ ] .json files upload successfully
- [ ] .pdf files upload successfully

---

## 8. PROMPT CLEANER (Claude Mode Only)

### Access

- [ ] Prompt cleaner button (sparkles) visible in Claude mode only
- [ ] Prompt cleaner button NOT visible in shell mode
- [ ] Prompt cleaner button NOT visible for ad-hoc panes

### Basic Flow

- [ ] Type text in Claude aterm
- [ ] Click prompt cleaner button
- [ ] Modal opens with last aterm line
- [ ] AI processes prompt (loading state)
- [ ] Typewriter animation shows cleaned version

### Modal Actions

- [ ] Toggle diff → side-by-side original vs cleaned
- [ ] Click edit → manual editing enabled
- [ ] Type refinement → re-processes with instructions
- [ ] Click Send → cleaned prompt inserted into aterm
- [ ] Click Cancel → modal closes, no action

---

## 9. KEYBOARD SHORTCUTS

### Global Shortcuts

- [ ] `?` → keyboard shortcuts overlay opens
- [ ] `Ctrl+T` → A-Term Manager modal opens
- [ ] `Ctrl+W` → closes active pane (with confirmation)
- [ ] `Ctrl+Tab` → cycles to next pane
- [ ] `Ctrl+Shift+Tab` → cycles to previous pane
- [ ] `Ctrl+1` → switches to pane 1
- [ ] `Ctrl+2` → switches to pane 2
- [ ] `Ctrl+3` → switches to pane 3
- [ ] `Ctrl+4` → switches to pane 4
- [ ] `Esc` → closes any open modal/overlay

### Shortcuts in Grid Mode

- [ ] Shortcuts work regardless of which pane is focused
- [ ] Ctrl+Tab cycles through all panes in order

---

## 10. SETTINGS

### Access Settings

- [ ] Single mode: click gear icon in header
- [ ] Grid mode: click gear icon in any pane header
- [ ] Settings dropdown opens

### Font Settings

- [ ] Font family dropdown shows 10 options
- [ ] Changing font updates aterm immediately
- [ ] Font size slider works (10-20px range)
- [ ] Font changes persist after reload

### Theme Settings

- [ ] Theme dropdown shows 5 options
- [ ] Changing theme updates aterm colors immediately
- [ ] Theme persists after reload

### Cursor Settings

- [ ] Cursor style: Block, Underline, Bar options
- [ ] Changing style updates cursor immediately
- [ ] Cursor blink toggle works
- [ ] Settings persist after reload

### Scrollback Settings

- [ ] Options: 1K, 10K, 50K, Unlimited
- [ ] Setting persists after reload

### Project-Specific Settings

- [ ] Change settings while in project pane
- [ ] Switch to different project
- [ ] Settings are independent per project
- [ ] Global settings used as fallback

---

## 11. CONNECTION STATES

### Normal Connection

- [ ] A-Term connects on load
- [ ] Skeleton loader during connection
- [ ] Normal aterm after connected

### Disconnection

- [ ] Simulate network disconnect
- [ ] Yellow indicator appears
- [ ] Auto-reconnect attempted
- [ ] Reconnects when network restored

### Error State

- [ ] Simulate connection error
- [ ] Red indicator appears
- [ ] "Reconnect" button available
- [ ] Click reconnect → attempts reconnection

### Session Dead

- [ ] Kill tmux session externally
- [ ] A-Term shows "session dead" message
- [ ] Close pane to cleanup

### Timeout

- [ ] Connection timeout after 10s
- [ ] Error state shown
- [ ] Can refresh or reconnect

---

## 12. MOBILE BEHAVIOR

### Layout on Mobile

- [ ] Grid mode hidden on mobile (< 768px)
- [ ] Only single mode available
- [ ] Layout selector hidden
- [ ] Touch scrolling works on aterm

### Mobile Keyboard - Control Bar

- [ ] Control bar visible at bottom
- [ ] Arrow keys (↑ ↓ ← →) work
- [ ] Tab key works
- [ ] Esc key works
- [ ] Ctrl modifier key works

### Mobile Keyboard - Full Keyboard

- [ ] Click expand → full QWERTY appears
- [ ] All letter keys work
- [ ] Number keys work
- [ ] Special characters work
- [ ] Click minimize → returns to control bar

### Mobile Keyboard - Settings

- [ ] Keyboard size setting available (small/medium/large)
- [ ] Changing size updates keyboard immediately
- [ ] Size persists after reload
- [ ] Minimized state persists after reload

---

## 13. URL & NAVIGATION

### Session URL Parameter

- [ ] Open `/?session=<valid-id>` → that session active
- [ ] Open `/?session=<invalid-id>` → graceful fallback

### Project URL Parameter

- [ ] Open `/?project=<id>` → project pane active
- [ ] Open `/?project=<invalid>` → graceful fallback

### Browser Navigation

- [ ] Switch aterms → URL updates
- [ ] Click browser back → returns to previous session
- [ ] Click browser forward → goes to next session

### Deep Linking

- [ ] Copy URL with session parameter
- [ ] Open in new tab → same session displayed

---

## 14. DATA PERSISTENCE

### Panes & Sessions

- [ ] Create panes → survive browser refresh
- [ ] Create panes → survive browser close/reopen
- [ ] Pane order persists after drag-drop reorder

### A-Term History

- [ ] Type commands → history visible
- [ ] Refresh page → history preserved (tmux scrollback)
- [ ] Reset aterm → history cleared

### Settings

- [ ] Change settings → persist after refresh
- [ ] Change settings → persist after browser close
- [ ] Project settings independent of global

### Mobile Keyboard State

- [ ] Minimize keyboard → state persists
- [ ] Change size → persists after refresh

---

## 15. EDGE CASES

### Rapid Actions

- [ ] Click mode toggle rapidly → only one switch occurs
- [ ] Click create aterm rapidly → only one pane created
- [ ] Click close rapidly → only one confirmation shown

### Network Issues

- [ ] Upload file during network drop → error handled gracefully
- [ ] Mode switch during network drop → error handled gracefully
- [ ] Create aterm during network drop → error handled gracefully

### Concurrent Operations

- [ ] Switch modes while upload in progress → both complete correctly
- [ ] Create pane while another creating → handled correctly
- [ ] Close pane while mode switching → handled correctly

### Browser Refresh

- [ ] Refresh during upload → upload lost (expected)
- [ ] Refresh during mode switch → state consistent after reload
- [ ] Refresh during pane creation → pane exists or doesn't (no partial state)

---

## 16. VISUAL STATES

### Mode Toggle Button

- [ ] Shell (inactive): dim aterm icon
- [ ] Claude (active): glowing sparkles with animation
- [ ] Loading: spinner icon
- [ ] Disabled: grayed out, no hover effect

### Claude Indicator (in switcher)

- [ ] Shell pane: no indicator
- [ ] Claude pane idle: static ring
- [ ] Claude pane active: breathing animation

### Pane Border (Grid Mode)

- [ ] Inactive pane: subtle border
- [ ] Active pane: highlighted/accent border
- [ ] Dragging pane: shadow + accent border

### Confirmation Dialogs

- [ ] Close aterm: shows warning message
- [ ] Close all: shows warning about all aterms
- [ ] Reset all: shows warning about clearing history
- [ ] Dialogs have Cancel and Confirm buttons

---

## 17. ACCESSIBILITY

### Keyboard Navigation

- [ ] Tab through all interactive elements
- [ ] Focus visible on all buttons
- [ ] Enter/Space activates focused button
- [ ] Esc closes modals

### Screen Reader

- [ ] Buttons have meaningful labels
- [ ] Status changes announced
- [ ] Modal has proper ARIA roles

---

## Test Run Log

| Date | Tester | Passed | Failed | Notes |
|------|--------|--------|--------|-------|
| | | | | |
| | | | | |
| | | | | |

---

## Known Issues

Document any discovered issues here:

1.
2.
3.

---

## Notes

- All tests should be run on both desktop (>1280px) and mobile (<768px) viewports where applicable
- Grid mode tests only applicable on desktop
- Mobile keyboard tests only applicable on mobile/touch devices
- Test with multiple browsers: Chrome, Firefox, Safari
