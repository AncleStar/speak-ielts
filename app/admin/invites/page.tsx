import { requireAdmin } from "@/lib/auth-server";
import { listInvites } from "@/lib/services/invites";
import { InviteManager } from "@/components/admin/invite-manager";
export default async function InvitePage() {
  await requireAdmin();
  return <div><h1 className="page-title">邀请朋友试用</h1><p className="my-4 text-sm text-muted">每个邀请码仅能创建一个普通账号；可限定邮箱。原始邀请码只在创建时显示。</p>
    <InviteManager rows={JSON.parse(JSON.stringify(await listInvites()))} /></div>;
}
