interface Command { command: string; description: string; takesArgument?: boolean }
export const commands: Command[] = [
  { command: '/help', description: '查看命令与快捷键' },
  { command: '/model', description: '配置服务、选择模型并测试连接' },
  { command: '/new', description: '开启新对话，保留旧会话' },
  { command: '/thinking', description: '切换思考展开 / 收起，并记住设置' },
  { command: '/clear', description: '清空当前会话上下文' },
  { command: '/exit', description: '退出 icy' },
  { command: '/task', description: '查看任务、待办、预算与验收记录' },
  { command: '/continue', description: '以新预算继续原任务' },
  { command: '/verify', description: '指定并执行验收命令，沿用 shell 审批', takesArgument: true },
  { command: '/todo', description: '添加待办事项', takesArgument: true },
  { command: '/done', description: '完成待办，编号从 1 开始', takesArgument: true },
  { command: '/sessions', description: '列出已保存会话；可用 status=<状态,...> 与 cwd=<目录> 过滤', takesArgument: true },
  { command: '/resume', description: '恢复指定会话 ID', takesArgument: true },
];
export function matchCommands(input: string): Command[] {
  if (!input.startsWith('/') || input.includes('\n')) return [];
  const candidates = input.startsWith('/thinking ') ? [
    { command: '/thinking expanded', description: '展开思考内容' },
    { command: '/thinking collapsed', description: '收起思考内容' },
  ] : commands;
  return candidates.filter(item => item.command.startsWith(input.toLowerCase()));
}
