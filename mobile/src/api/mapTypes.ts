export interface MapLine {
  id: number;
  name?: string | null;
  line_id?: string | null;
  voltage_kv?: number | null;
  color?: string | null;
  route: Array<[number, number]> | null;
  region_id?: number | null;
}

export interface MapTower {
  id: number;
  tower_id?: string | null;
  line_id?: number;
  line_name?: string | null;
  position: [number, number];
  color?: string | null;
}

export interface MapData {
  lines: MapLine[];
  towers: MapTower[];
}
