export function iCloudImapMessageIsRead(line: string): boolean {
  const flags = line.match(/\bFLAGS\s+\(([^)]*)\)/i)?.[1] || ''
  return flags.split(/\s+/).some((flag) => flag.toLowerCase() === '\\seen')
}

export function iCloudImapReadUpdate(
  line: string,
  uid: string,
): { isRead: boolean; markSeenCommand?: string } {
  const isRead = iCloudImapMessageIsRead(line)
  return isRead
    ? { isRead }
    : { isRead, markSeenCommand: `UID STORE ${uid} +FLAGS.SILENT (\\Seen)` }
}
