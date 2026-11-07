/** Three placeholder rows while a status-style list loads (the same bars as a row). */
export function SkeletonRows() {
  return (
    <div className="status-rows skeleton" aria-hidden="true">
      {[30, 45, 25].map((width) => (
        <div key={width} className="status-row">
          <div>
            <span className="bar pill" />
          </div>
          <div>
            <div className="bar" style={{ width: `${width}%` }} />
            <div className="bar dim" style={{ width: `${width + 20}%` }} />
          </div>
          <div className="when">—</div>
        </div>
      ))}
    </div>
  )
}
