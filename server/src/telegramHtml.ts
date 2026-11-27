// Telegram HTML parse mode accepts a small tag set. Everything else that looks like
// markup, and any stray "<", ">" or "&", makes sendMessage fail with "can't parse entities".

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'tg-spoiler', 'blockquote']);
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

export type HtmlCheck = { ok: true; visibleLength: number } | { ok: false; reason: string };

export function checkTelegramHtml(html: string): HtmlCheck {
  const stack: string[] = [];
  let visible = 0;
  let index = 0;
  while (index < html.length) {
    const char = html[index];
    if (char === '<') {
      const end = html.indexOf('>', index);
      if (end === -1) return { ok: false, reason: 'Незакрытый символ «<». Используйте &lt; для знака «меньше».' };
      const inner = html.slice(index + 1, end);
      const closing = inner.startsWith('/');
      const match = /^\/?([A-Za-z][A-Za-z0-9-]*)(\s[^<>]*)?$/.exec(inner);
      if (!match) return { ok: false, reason: `Непонятный тег «<${inner.slice(0, 20)}». Знак «<» пишите как &lt;.` };
      const name = match[1].toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return { ok: false, reason: `Тег <${name}> Telegram не поддерживает.` };
      if (closing) {
        if (match[2]) return { ok: false, reason: `Закрывающий тег </${name}> не должен иметь атрибутов.` };
        if (stack.pop() !== name) return { ok: false, reason: `Тег </${name}> закрыт не там, где открыт.` };
      } else {
        if (name === 'a' && !/\shref\s*=\s*"https?:\/\/[^"\s<>]+"/i.test(match[2] ?? '')) {
          return { ok: false, reason: 'Ссылка <a> должна иметь href="https://..." в двойных кавычках.' };
        }
        stack.push(name);
      }
      index = end + 1;
      continue;
    }
    if (char === '>') return { ok: false, reason: 'Одиночный символ «>». Пишите &gt;.' };
    if (char === '&') {
      const match = /^&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/.exec(html.slice(index, index + 12));
      if (!match) return { ok: false, reason: 'Одиночный символ «&». Пишите &amp;.' };
      const named = match[1];
      if (!named.startsWith('#') && !(named in NAMED_ENTITIES)) {
        return { ok: false, reason: `Сущность &${named}; Telegram не поддерживает. Допустимы &lt; &gt; &amp; &quot;.` };
      }
      visible += 1;
      index += match[0].length;
      continue;
    }
    // Telegram counts UTF-16 code units, which is what String.length returns.
    visible += 1;
    index += 1;
  }
  if (stack.length > 0) return { ok: false, reason: `Тег <${stack[stack.length - 1]}> не закрыт.` };
  return { ok: true, visibleLength: visible };
}
