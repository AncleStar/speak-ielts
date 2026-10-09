import { getAuth } from "@/lib/auth";
import { handle } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const handler = handle((req: Request) => getAuth().handler(req));

export { handler as GET, handler as POST };
