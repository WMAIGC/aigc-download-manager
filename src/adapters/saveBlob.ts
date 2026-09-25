/**
 * 浏览器端将 Blob 触发为"另存为/下载"文件。
 *
 * 实现方式：objectURL + 临时锚点 click + 立即 revoke。
 * 仅在浏览器环境可用；核心逻辑不引用本模块，保持平台无关。
 */

/**
 * 触发浏览器下载指定 Blob。
 *
 * @param blob - 待保存的文件内容。
 * @param filename - 文件名；省略时由浏览器决定（blob URL 场景通常为 download）。
 */
export function saveBlob(blob: Blob, filename?: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  if (filename !== undefined && filename.length > 0) {
    anchor.download = filename;
  }
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 点击已同步派发给浏览器，随即释放 objectURL。
  URL.revokeObjectURL(objectUrl);
}
