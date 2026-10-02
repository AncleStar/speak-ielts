import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
export default function PasswordHelp() {
  return <Card><CardHeader><CardTitle>找回你的账号</CardTitle></CardHeader><CardContent className="space-y-5 text-sm leading-7">
    <p>请通过领取邀请码时的联系方式，联系管理员，并告知你的注册邮箱。</p>
    <ol className="list-decimal space-y-3 pl-5"><li>管理员核对身份后，在「后台 → 账号」重置密码。</li><li>使用管理员提供的临时密码登录；系统会要求你立即设置新密码。</li><li>重置后，旧设备上的登录会失效。练习记录保留。</li></ol>
    <p className="text-muted">当前试用版未接入邮件服务，不会向邮箱发送重置链接。请勿向他人提供原密码或录音。</p>
    <LinkButton href="/login" className="w-full">返回登录</LinkButton>
  </CardContent></Card>;
}
