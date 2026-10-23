// Android-like keyboard layout configuration
export const KEYBOARD_LAYOUT = {
  default: [
    '1 2 3 4 5 6 7 8 9 0',
    'q w e r t y u i o p',
    'a s d f g h j k l',
    '{shift} z x c v b n m {bksp}',
    '{sym} , {space} . {enter}',
  ],
  shift: [
    '1 2 3 4 5 6 7 8 9 0',
    'Q W E R T Y U I O P',
    'A S D F G H J K L',
    '{shift} Z X C V B N M {bksp}',
    '{sym} , {space} . {enter}',
  ],
  symbols: [
    '! @ # $ % ^ & * ( )',
    "- _ = + [ ] \\ ' / ~",
    '` < > { } : ; " ?',
    '{shift} € £ ¥ • ° ± § {bksp}',
    '{abc} | {space} , {enter}',
  ],
}

export const KEYBOARD_DISPLAY = {
  '{bksp}': '⌫',
  '{enter}': '↵',
  '{shift}': '⇧',
  '{space}': ' ',
  '{sym}': '?123',
  '{abc}': 'ABC',
}
