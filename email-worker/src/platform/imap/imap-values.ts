export function quoteImapValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('IMAP 登录信息包含无效字符。')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
