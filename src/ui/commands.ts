export const commands = [
  { command: '/help', description: '查看命令与快捷键' },
  { command: '/model', description: '配置服务、选择模型并测试连接' },
  { command: '/new', description: '开启新对话，保留旧会话' },
  { command: '/thinking', description: '切换思考展开 / 收起，并记住设置' },
  { command: '/clear', description: '清空当前会话上下文' },
  { command: '/exit', description: '退出 icy' },
];
export function matchCommands(input: string) {
  if (!input.startsWith('/') || input.includes('\n')) return [];
  const candidates = input.startsWith('/thinking ') ? [
    { command: '/thinking expanded', description: '展开思考内容' },
    { command: '/thinking collapsed', description: '收起思考内容' },
  ] : commands;
  return candidates.filter(item => item.command.startsWith(input.toLowerCase()));
}
