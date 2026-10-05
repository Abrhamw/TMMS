export default function WorkPanelOverlay({ children }) {
  return (
    <div className="work-panel-overlay">
      <div className="work-panel-scrim" aria-hidden="true" />
      <div className="work-panel work-panel--modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
