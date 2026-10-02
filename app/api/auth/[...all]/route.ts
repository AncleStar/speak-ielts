import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const handler = (req: Request) => getAuth().handler(req);

export { handler as GET, handler as POST };
