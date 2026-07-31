export function forceLightEmailColorScheme(css: string): string {
  return css.replace(
    /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi,
    '(prefers-color-scheme: omnimail-disabled)',
  )
}

export function forceLightEmailDocument(document: Document): void {
  document.querySelectorAll('meta[name="color-scheme"], meta[name="supported-color-schemes"]')
    .forEach((node) => node.remove())
  document.querySelectorAll('style').forEach((style) => {
    style.textContent = forceLightEmailColorScheme(style.textContent ?? '')
  })
}

export function loadDeferredRemoteImages(
  document: Document,
  onSettled: () => void,
): void {
  document.querySelectorAll<HTMLImageElement>('img[data-omnimail-src]').forEach((image) => {
    const source = image.dataset.omnimailSrc
    if (!source) return
    image.addEventListener('load', onSettled, { once: true })
    image.addEventListener('error', onSettled, { once: true })
    image.removeAttribute('data-omnimail-src')
    image.setAttribute('src', source)
  })
}
