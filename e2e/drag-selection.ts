import type { Page } from '@playwright/test'

export async function dragAcrossMessageRows(
  page: Page,
  startIndex: number,
  endIndex: number,
) {
  const rows = page.locator('.message-row__main')
  const start = await rows.nth(startIndex).boundingBox()
  if (!start) throw new Error('Drag selection start row is not visible')
  await page.mouse.move(start.x + 24, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 24, start.y + start.height / 2 + 8)
  await page.locator('.message-list.is-bulk-mode').waitFor()
  const end = await rows.nth(endIndex).boundingBox()
  if (!end) throw new Error('Drag selection end row is not visible')
  await page.mouse.move(end.x + 24, end.y + end.height / 2)
  await page.mouse.up()
}
