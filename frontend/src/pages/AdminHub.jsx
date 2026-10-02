import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs } from '../components/viz';
import Reports from './Reports';
import Value from './Value';
import Organization from './Organization';
import Settings from './Settings';
import OperatingModel from './OperatingModel';
import Gps from './Gps';
import DataValidation from './DataValidation';

const TABS = [
  { key: 'reports', label: 'Reports' },
  { key: 'value', label: 'Value & Cost' },
  { key: 'organization', label: 'Organization' },
  { key: 'settings', label: 'Settings' },
  { key: 'tools', label: 'Tools' },
];

const TOOLS = [
  { key: 'gps', label: 'GPS Validation' },
  { key: 'validation', label: 'Data Validation' },
  { key: 'model', label: 'Operating Model' },
];

export default function AdminHub() {
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => {
    const area = searchParams.get('area');
    return TABS.some((t) => t.key === area) ? area : 'reports';
  }, []);
  const [area, setArea] = useState(initial);
  const initialTool = useMemo(() => {
    const tool = searchParams.get('tool');
    return TOOLS.some((t) => t.key === tool) ? tool : 'gps';
  }, []);
  const [tool, setTool] = useState(initialTool);

  return (
    <>
      <div className="hub-tabs-bar">
        <Tabs tabs={TABS} active={area} onChange={setArea} />
        {area === 'tools' && (
          <div className="mt" style={{ paddingBottom: 10 }}>
            <Tabs tabs={TOOLS} active={tool} onChange={setTool} />
          </div>
        )}
      </div>
      {area === 'reports' && <Reports />}
      {area === 'value' && <Value />}
      {area === 'organization' && <Organization />}
      {area === 'settings' && <Settings />}
      {area === 'tools' && tool === 'gps' && <Gps />}
      {area === 'tools' && tool === 'validation' && <DataValidation />}
      {area === 'tools' && tool === 'model' && <OperatingModel />}
    </>
  );
}
