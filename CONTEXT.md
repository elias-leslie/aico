# Aico session context

Aico presents durable terminal sessions as desktop windows. A session can be opened from Aico or A-Term without starting another agent process.

## Language

**Project**:
The working directory and project identity selected when starting a session.
_Avoid_: Workspace, when naming the choice in the user interface

**Session**:
One running terminal workload and its durable tmux state, created in Aico or A-Term. Closing a view does not end it.
_Avoid_: Widget, attachment, pane, when naming the workload in the user interface

**View**:
A local Aico window or A-Term tab that shows an existing session. Several views may show the same session.
_Avoid_: Session, when only the local display is being closed

**Owner**:
The app that created a session and can verify and end its underlying workload. The other app asks that owner to end it.
_Avoid_: Attachment, when describing authority to end a session
