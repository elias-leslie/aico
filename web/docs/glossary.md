# A-Term session context

A-Term presents durable terminal sessions on mobile and desktop. Sessions are owned by Tether, the local session daemon; A-Term and Aico are both views onto them, so a session can be opened from either app without starting another agent process.

## Language

**Project**:
The working directory and project identity selected when starting a session. The project list comes from Tether.
_Avoid_: Workspace, when naming the choice in the user interface

**Session**:
One running terminal workload and its durable tmux state, owned by Tether and created from A-Term or Aico. Closing a view does not end it.
_Avoid_: Widget, attachment, pane, when naming the workload in the user interface

**View**:
A local A-Term tab or Aico window that shows an existing session. Several views may show the same session.
_Avoid_: Session, when only the local display is being closed

**Owner**:
Tether, for every session either app creates. Ending, renaming, respawning and switching tools go through Tether whichever app asks.
_Avoid_: Attachment, when describing authority to end a session

**Origin**:
The app that created a session (`a-term` or `aico`). It is informational; it grants no extra authority.

**Legacy session**:
A session A-Term created before Tether, still running on the default tmux server. A-Term can show and end it but no longer restarts it; it disappears once it ends.
