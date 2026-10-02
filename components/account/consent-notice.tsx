export function ConsentNotice({ mock }: { mock: boolean }) {
  return (
    <div className="space-y-2 rounded-xl border border-line bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
      <p className="font-medium text-ink">录音与个人信息处理说明</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>收集内容：</b>练习时的语音录音、由录音生成的转写文本、练习记录（题目、作答时长、停顿指标、反馈）。不采集摄像头画面，不做声纹识别。
        </li>
        <li>
          <b>用途：</b>仅用于生成转写与练习反馈、记录学习进度与额度统计，不用于广告或其他目的。
        </li>
        <li>
          <b>受托处理：</b>录音与转写文本会发送给阿里云百炼（中国内地·北京）的语音识别与大模型服务处理，录音存放在私有存储中。
          {mock ? "（当前为模拟服务模式，录音不会发送给第三方服务。）" : null}
        </li>
        <li>
          <b>保存期限：</b>原始录音保存 30 天后自动删除；文本报告保留到你主动删除练习记录或删除账号为止。
        </li>
        <li>
          <b>删除方式：</b>可在“学习记录”中删除单次练习，或在“设置”中删除账号。删除后立即无法访问，相关文件与记录在 24 小时内清理。
        </li>
        <li>
          <b>管理员查看：</b>管理员默认只能看到运行状态和统计；只有你在设置中开启“允许管理员查看我的回答用于排查”后，管理员才能查看你的转写与反馈。
        </li>
      </ul>
      <p className="text-xs text-muted">你可以随时在设置中撤回同意；撤回后将无法继续录音练习，已有记录不受影响。</p>
    </div>
  );
}
