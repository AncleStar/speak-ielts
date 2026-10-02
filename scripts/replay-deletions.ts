import "./_env";
import { replayDeletions } from "@/lib/services/deletion";
import { closeDb } from "@/lib/db";
try { console.log("删除记录重放结果：", await replayDeletions()); }
finally { await closeDb(); }
