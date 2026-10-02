import {describe,it,expect} from "vitest";
import {ArchiveCatalog} from "@/components/disc/rhine/catalog";

describe("question-backed circular disc catalog",()=>{
  const catalog=new ArchiveCatalog([{id:"home-1",column:"Home"},{id:"home-2",column:"Home"},{id:"work-1",column:"Work"},{id:"work-2",column:"Work"},{id:"work-3",column:"Work"}]);
  it("wraps both directions with unequal topic sizes",()=>{
    expect(catalog.navigate(0,"row",-1)).toBe(1);
    expect(catalog.navigate(4,"row",1)).toBe(2);
    expect(catalog.navigate(4,"lane",1)).toBe(1);
    for(let row=-80;row<80;row++){
      expect([0,1]).toContain(catalog.fileAtCell({lane:-2,row}));
      expect([2,3,4]).toContain(catalog.fileAtCell({lane:19,row}));
    }
  });
  it("moves forward through a wrap without rewinding the physical track",()=>{
    const cell=catalog.selectionCell(0,{lane:0,row:13},{axis:"row",direction:1});
    expect(cell).toEqual({lane:0,row:14});expect(catalog.fileAtCell(cell)).toBe(0);
    expect(catalog.fileAtCell(catalog.selectionCell(3,{lane:100,row:-77}))).toBe(3);
  });
  it("keeps filtered singleton and empty results bounded",()=>{
    const single=new ArchiveCatalog([{id:"one"}]);
    expect(single.navigate(0,"row",1)).toBe(0);
    expect(single.fileAtCell({lane:-400,row:6000})).toBe(0);
    expect(new ArchiveCatalog([]).navigate(0,"lane",1)).toBe(0);
  });
});
