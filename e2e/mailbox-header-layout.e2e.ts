import { expect, type Page, test } from '@playwright/test'

async function renderMailboxHeader(page: Page, paneWidth: number) {
  await page.setContent(`
    <section class="list-pane" style="width:${paneWidth}px;height:400px">
      <header class="list-header">
        <div class="list-header__scope-row">
          <div class="mailbox-switcher">
            <button class="mailbox-scope-trigger" type="button">
              <span>当前邮箱</span>
              <strong>所有邮箱</strong>
              <svg width="14" height="14"></svg>
            </button>
          </div>
          <div class="list-header__utilities">
            <button class="icon-button" type="button"></button>
            <button class="icon-button" type="button"></button>
          </div>
        </div>
        <div class="list-header__title-row">
          <h1>星标邮件</h1>
          <div class="list-header__actions">
            <button class="icon-button" type="button"></button>
            <button class="icon-button" type="button"></button>
            <button class="icon-button" type="button"></button>
          </div>
        </div>
      </header>
    </section>
  `)
  await page.addStyleTag({ path: 'src/styles.css' })
  await page.addStyleTag({ path: 'src/styles/mailbox.css' })
  await page.addStyleTag({ path: 'src/styles/mailbox-header.css' })
  await page.addStyleTag({ path: 'src/styles/mailbox-switcher.css' })
}

test('mailbox header actions stay inside narrow desktop list panes', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 })

  for (const paneWidth of [366, 330, 320]) {
    await renderMailboxHeader(page, paneWidth)
    const layout = await page.locator('.list-header').evaluate((header) => {
      const pane = header.parentElement!.getBoundingClientRect()
      const scope = header.querySelector('.mailbox-switcher')!.getBoundingClientRect()
      const utilities = header.querySelector('.list-header__utilities')!.getBoundingClientRect()
      const title = header.querySelector('h1')!.getBoundingClientRect()
      const actions = header.querySelector('.list-header__actions')!.getBoundingClientRect()
      return {
        utilitiesInsidePane: utilities.right <= pane.right + 1,
        scopeClearOfUtilities: scope.right <= utilities.left,
        actionsInsidePane: actions.right <= pane.right + 1,
        titleClearOfActions: title.right <= actions.left || title.bottom <= actions.top,
        noHorizontalOverflow: header.scrollWidth <= header.clientWidth,
      }
    })

    expect(layout).toEqual({
      utilitiesInsidePane: true,
      scopeClearOfUtilities: true,
      actionsInsidePane: true,
      titleClearOfActions: true,
      noHorizontalOverflow: true,
    })
  }
})
