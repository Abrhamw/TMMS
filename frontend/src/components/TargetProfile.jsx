import { Fragment } from 'react';
import { targetDetailRows, readinessNotes, recommendedEquipment, workflowRows } from '../checklistFormat';
import RouteSketch, { hasRouteSketch } from './RouteSketch';
import SubstationMap, { hasSubstationMap } from './SubstationMap';

function KvRows({ rows, labelWidth = 170 }) {
  return (
    <div className="kv" style={{ gridTemplateColumns: `${labelWidth}px 1fr`, fontSize: 13 }}>
      {rows.map((r) => (
        <Fragment key={r.label}>
          <span className="k">{r.label}</span>
          <span>{r.value}</span>
        </Fragment>
      ))}
    </div>
  );
}

// Everything a printed execution / task report must state about its target and
// its governance: the line (with start and end), the substation premises, the
// tower, the asset and whether it is installed indoors or outdoors; the
// certifications and test equipment still to be secured; and the people who
// created, assigned, executed and verified the work, in lifecycle order.
export default function TargetProfile({ target, readiness, workflow, detailTitle = 'Work location detail', mapTitle = 'Route map', substationMapTitle = 'Location map', withMap = true }) {
  const routeMode = withMap && hasRouteSketch(target);
  const mapMode = withMap && !routeMode && hasSubstationMap(target);
  // The substation map caption already states the premises/asset description, so
  // drop those rows from the detail when the map carries them.
  const details = targetDetailRows(target).filter((r) => !(mapMode && (r.label === 'Premises detail' || r.label === 'Asset detail')));
  const notes = readinessNotes(readiness);
  const equipment = recommendedEquipment(readiness);
  const people = workflowRows(workflow);
  const showMap = routeMode || mapMode;
  if (!details.length && !notes.length && !people.length && !equipment.length) return null;
  return (
    <div className="target-profile">
      {details.length > 0 && (
        <div className="mt">
          {showMap ? (
            <div className="target-split">
              <div>
                <h4 className="section-title">{detailTitle}</h4>
                <KvRows rows={details} labelWidth={150} />
              </div>
              <div className="target-split-map">
                <h4 className="section-title">{routeMode ? mapTitle : substationMapTitle}</h4>
                {routeMode ? <RouteSketch target={target} /> : <SubstationMap target={target} />}
              </div>
            </div>
          ) : (
            <>
              <h4 className="section-title">{detailTitle}</h4>
              <KvRows rows={details} />
            </>
          )}
        </div>
      )}
      {notes.length > 0 && (
        <div className="note mt">
          <b>Dispatch note — missed items</b>
          <KvRows rows={notes} labelWidth={150} />
        </div>
      )}
      {equipment.length > 0 && (
        <div className="mt">
          <h4 className="section-title">Recommended equipment for this job</h4>
          <div className="equip-list">
            {equipment.map((e, i) => {
              const check = (readiness.equipment_checks || []).find((item) => item.equipment === e);
              const status = check ? check.status : 'NOT CHECKED';
              return (
              <span className="equip-item" key={`${e}-${i}`}>
                <span className={`equip-status ${status === 'USED' ? 'used' : 'missed'}`}>{status}</span>
                <span>{e}</span>
              </span>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Checked equipment is recorded as used; unchecked recommendations are reported as missed.</div>
        </div>
      )}
      {people.length > 0 && (
        <div className="mt">
          <h4 className="section-title">Workflow</h4>
          <KvRows rows={people} labelWidth={120} />
        </div>
      )}
    </div>
  );
}
