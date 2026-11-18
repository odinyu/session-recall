# The README GIF: search a real problem, open a session, copy the handoff.
# Rendered with `vhs docs/tui-demo.tape`. Fixed size so the README embedding
# never reflows; Theme set explicitly so it looks the same on every machine.

Output docs/tui-demo.gif
Set FontSize 15
Set Width 980
Set Height 560
Set Theme "OneDark"
Set Padding 24
Set Margin 0
Set Shell fish
Set CursorBlink false

Require session-recall

Type "session-recall tui"
Enter
Sleep 3s

# Search the way a person would: half a thought, in their own language.
Type "中文"
Sleep 2s
Backspace 2
Sleep 300ms
Type "grok"
Sleep 2s

# Move through the results; the right pane follows.
Down
Sleep 500ms
Down
Sleep 500ms
Up
Sleep 1s

# Clear, switch to tool-call scope, search a tool name.
Escape
Sleep 500ms
Tab
Sleep 1s
Type "doctor"
Sleep 2s

Down
Sleep 500ms
Down
Sleep 1.2s

# Copy the handoff card for the selected session.
Ctrl+Y
Sleep 1.5s
