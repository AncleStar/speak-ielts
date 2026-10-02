import { nearestOccurrence, wrap, type ArchiveCell, type ArchiveNavigation } from "./archive-loop";

export interface DiscRecord { id: string; column?: string; title?: string }

/** Each mounted scene owns its data; there is no global user/question catalog. */
export class ArchiveCatalog {
  readonly columns: string[];
  readonly rows: number[][];
  constructor(public readonly records: DiscRecord[]) {
    this.columns = [...new Set(records.map(r => r.column ?? "TRAINING"))];
    if (!this.columns.length) this.columns.push("TRAINING");
    this.rows = this.columns.map(column => records.flatMap((r, i) => (r.column ?? "TRAINING") === column ? [i] : []));
  }
  columnFiles(lane: number) { return this.rows[wrap(lane, this.rows.length)]; }
  fileLocation(index: number) {
    const lane = Math.max(0, this.columns.indexOf(this.records[index]?.column ?? "TRAINING"));
    const row = 12 + Math.max(0, this.columnFiles(lane).indexOf(index));
    return { lane, row, slot: lane * 32 + Math.min(31,row) };
  }
  fileAtSlot(slot: number) { const rows=this.columnFiles(Math.floor(slot/32)); return rows[Math.max(0,Math.min(rows.length-1,slot%32-12))] ?? 0; }
  fileAtCell({lane,row}: ArchiveCell) { const rows=this.columnFiles(lane); return rows[wrap(row-12,rows.length)] ?? 0; }
  selectionCell(index: number, current: ArchiveCell, navigation?: ArchiveNavigation): ArchiveCell {
    if (navigation && "cell" in navigation) return {...navigation.cell};
    const next=this.fileLocation(index);
    if (navigation && "axis" in navigation && navigation.axis === "row") return {lane:current.lane,row:current.row+navigation.direction};
    return {lane:navigation && "axis" in navigation ? current.lane+navigation.direction : nearestOccurrence(next.lane,current.lane,this.columns.length),row:nearestOccurrence(next.row,current.row,this.columnFiles(next.lane).length)};
  }
  navigate(index: number, axis: "row"|"lane", direction: number) {
    const {lane}=this.fileLocation(index), rows=this.columnFiles(lane);
    if(axis === "row") return rows[wrap(rows.indexOf(index)+direction,rows.length)] ?? index;
    const next=this.columnFiles(lane+direction);return next[Math.min(Math.max(0,rows.indexOf(index)),next.length-1)] ?? index;
  }
}
