# A-Term session context

A-Term presents durable terminal sessions on mobile and desktop. A session can be opened from A-Term or Aico without starting another agent process.

## Language

**Project**:
The working directory and project identity selected when starting a session.
_Avoid_: Workspace, when naming the choice in the user interface

**Session**:
One running terminal workload and its durable tmux state, created in A-Term or Aico. Closing a view does not end it.
_Avoid_: Widget, attachment, pane, when naming the workload in the user interface

**View**:
A local A-Term tab or Aico window that shows an existing session. Several views may show the same session.
_Avoid_: Session, when only the local display is being closed

**Owner**:
The app that created a session and can verify and end its underlying workload. The other app asks that owner to end it.
_Avoid_: Attachment, when describing authority to end a session
