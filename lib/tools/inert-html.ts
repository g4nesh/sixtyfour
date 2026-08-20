export interface HtmlContainerBlock {
  tagName: string;
  openingTag: string;
  attributes: string;
  body: string;
  closingTag: string | null;
  selfClosing: boolean;
}

interface HtmlTagToken {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  source: string;
  attributes: string;
}

export interface InertHtmlProjection {
  /** Active markup with comments, title RCDATA, and inactive bodies removed. */
  passiveHtml: string;
  /** Active markup plus genuine script/iframe opening tags for src inspection. */
  resourceHtml: string;
  /** Active markup plus inert-container opening tags for bounded structure counts. */
  structuralHtml: string;
  /** Genuine title blocks outside every inactive ancestor. */
  titleHtml: string;
  /** Genuine application/ld+json blocks outside every inactive ancestor. */
  jsonLdHtml: string;
}

const INACTIVE_CONTAINERS = new Set([
  "canvas",
  "iframe",
  "math",
  "noscript",
  "object",
  "plaintext",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xmp",
]);

const RAW_TEXT_CONTAINERS = new Set([
  "iframe",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const NAMED_CHARACTER_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  AMP: "&",
  apos: "'",
  aacute: "á",
  Aacute: "Á",
  acirc: "â",
  Acirc: "Â",
  agrave: "à",
  Agrave: "À",
  aring: "å",
  Aring: "Å",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  Auml: "Ä",
  bull: "•",
  cent: "¢",
  commat: "@",
  copy: "©",
  COPY: "©",
  deg: "°",
  divide: "÷",
  eacute: "é",
  Eacute: "É",
  ecirc: "ê",
  Ecirc: "Ê",
  egrave: "è",
  Egrave: "È",
  emsp: " ",
  ensp: " ",
  euml: "ë",
  Euml: "Ë",
  euro: "€",
  gt: ">",
  GT: ">",
  hairsp: " ",
  hellip: "…",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  Icirc: "Î",
  iexcl: "¡",
  igrave: "ì",
  Igrave: "Ì",
  iquest: "¿",
  iuml: "ï",
  Iuml: "Ï",
  laquo: "«",
  ldquo: "“",
  lsaquo: "‹",
  lsquo: "‘",
  lowbar: "_",
  lt: "<",
  LT: "<",
  mdash: "—",
  micro: "µ",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  ntilde: "ñ",
  Ntilde: "Ñ",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  ograve: "ò",
  Ograve: "Ò",
  oslash: "ø",
  Oslash: "Ø",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  Ouml: "Ö",
  para: "¶",
  plusmn: "±",
  pound: "£",
  quot: "\"",
  QUOT: "\"",
  raquo: "»",
  rdquo: "”",
  reg: "®",
  REG: "®",
  rsaquo: "›",
  rsquo: "’",
  sect: "§",
  shy: "",
  thinsp: " ",
  times: "×",
  trade: "™",
  uacute: "ú",
  Uacute: "Ú",
  ucirc: "û",
  Ucirc: "Û",
  ugrave: "ù",
  Ugrave: "Ù",
  uuml: "ü",
  Uuml: "Ü",
  yacute: "ý",
  Yacute: "Ý",
  yen: "¥",
  yuml: "ÿ",
  Yuml: "Ÿ",
  ZeroWidthSpace: "\u200b",
  zwnj: "\u200c",
  zwj: "\u200d",
};

const UNRESOLVED_CHARACTER_REFERENCE = /&(?:#(?:[xX][0-9A-Fa-f]*|[0-9]*);?|[A-Za-z][A-Za-z0-9]{1,64};)/;
const ASCII_TAG_WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]);

function tagNameDelimiter(character: string | undefined): boolean {
  return character === undefined
    || character === "/"
    || character === ">"
    || ASCII_TAG_WHITESPACE.has(character);
}

function tagNameCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9:-]/.test(character));
}

interface CharacterReferencePass {
  value: string;
  invalid: boolean;
}

function decodeCharacterReferencePass(value: string): CharacterReferencePass {
  let output = "";
  let cursor = 0;
  let invalid = false;
  while (cursor < value.length) {
    const start = value.indexOf("&", cursor);
    if (start < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, start);
    if (value[start + 1] === "#") {
      let index = start + 2;
      const hexadecimal = value[index] === "x" || value[index] === "X";
      if (hexadecimal) index += 1;
      const digitStart = index;
      const digit = hexadecimal ? /[0-9A-Fa-f]/ : /[0-9]/;
      while (index < value.length && digit.test(value[index])) index += 1;
      if (index === digitStart) {
        output += "&";
        cursor = start + 1;
        continue;
      }
      const digits = value.slice(digitStart, index);
      const significantDigits = digits.replace(/^0+/, "") || "0";
      const maximumDigits = hexadecimal ? 6 : 7;
      let codePoint: number | null = null;
      if (significantDigits.length <= maximumDigits) {
        codePoint = Number.parseInt(significantDigits, hexadecimal ? 16 : 10);
      }
      const validCodePoint = codePoint !== null
        && codePoint > 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0x80 && codePoint <= 0x9f)
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      if (!validCodePoint) {
        invalid = true;
        output += "\ufffd";
      } else {
        output += String.fromCodePoint(codePoint as number);
      }
      cursor = value[index] === ";" ? index + 1 : index;
      continue;
    }
    let index = start + 1;
    while (index < value.length && /[A-Za-z0-9]/.test(value[index])) index += 1;
    if (index > start + 1 && value[index] === ";") {
      const name = value.slice(start + 1, index);
      const decoded = NAMED_CHARACTER_REFERENCES[name];
      if (decoded !== undefined) {
        output += decoded;
        cursor = index + 1;
        continue;
      }
      output += value.slice(start, index + 1);
      cursor = index + 1;
      continue;
    }
    output += "&";
    cursor = start + 1;
  }
  return { value: output, invalid };
}

/**
 * Decode at most two HTML character-reference layers before content-policy
 * inspection. Numeric references accept the HTML-legal omitted semicolon but
 * consume their whole digit run, so an overlong value cannot be misdecoded as
 * a safe prefix. Unknown named references and invalid numeric code points fail
 * closed instead of reaching a retained text surface.
 */
export function decodeHtmlTextForPolicy(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const result = decodeCharacterReferencePass(decoded);
    if (result.invalid) return null;
    decoded = result.value;
    if (decoded === value && pass === 0) break;
  }
  if (UNRESOLVED_CHARACTER_REFERENCE.test(decoded)) return null;
  return [...decoded].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const disallowedAscii = (codePoint < 32 && ![9, 10, 13].includes(codePoint))
      || (codePoint >= 127 && codePoint <= 159);
    const directionalControl = (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
    const zeroWidthFormatControl = codePoint === 0x200b
      || codePoint === 0x200c
      || codePoint === 0x200d
      || codePoint === 0x2060
      || codePoint === 0xfeff;
    return !disallowedAscii && !directionalControl && !zeroWidthFormatControl;
  }).join("");
}

function scanTags(html: string): HtmlTagToken[] {
  const tokens: HtmlTagToken[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const close = html.indexOf("-->", start + 4);
      cursor = close < 0 ? html.length : close + 3;
      continue;
    }
    let index = start + 1;
    const closing = html[index] === "/";
    if (closing) index += 1;
    const nameStart = index;
    while (tagNameCharacter(html[index])) index += 1;
    if (index === nameStart || !tagNameDelimiter(html[index])) {
      cursor = start + 1;
      continue;
    }
    const name = html.slice(nameStart, index).toLocaleLowerCase("en-US");
    const attributeStart = index;
    let quote: "\"" | "'" | null = null;
    let end = -1;
    while (index < html.length) {
      const character = html[index];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        end = index + 1;
        break;
      }
      index += 1;
    }
    if (end < 0) end = html.length;
    const source = html.slice(start, end);
    const selfClosing = !closing && /\/\s*>$/.test(source);
    const attributeEnd = Math.max(attributeStart, end - (selfClosing ? 2 : 1));
    tokens.push({
      start,
      end,
      name,
      closing,
      selfClosing,
      source,
      attributes: closing ? "" : html.slice(attributeStart, attributeEnd),
    });
    cursor = Math.max(start + 1, end);
  }
  return tokens;
}

function tagAt(html: string, start: number): HtmlTagToken | null {
  if (html[start] !== "<" || html.startsWith("<!--", start)) return null;
  let index = start + 1;
  const closing = html[index] === "/";
  if (closing) index += 1;
  const nameStart = index;
  while (tagNameCharacter(html[index])) index += 1;
  if (index === nameStart || !tagNameDelimiter(html[index])) return null;
  const name = html.slice(nameStart, index).toLocaleLowerCase("en-US");
  const attributeStart = index;
  let quote: "\"" | "'" | null = null;
  let end = -1;
  while (index < html.length) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      end = index + 1;
      break;
    }
    index += 1;
  }
  if (end < 0) end = html.length;
  const source = html.slice(start, end);
  const selfClosing = !closing && /\/\s*>$/.test(source);
  const attributeEnd = Math.max(attributeStart, end - (selfClosing ? 2 : 1));
  return {
    start,
    end,
    name,
    closing,
    selfClosing,
    source,
    attributes: closing ? "" : html.slice(attributeStart, attributeEnd),
  };
}

function declarationEnd(html: string, start: number): number {
  if (html.slice(start, start + 9).toLocaleUpperCase("en-US") === "<![CDATA[") {
    const close = html.indexOf("]]>", start + 9);
    return close < 0 ? html.length : close + 3;
  }
  let quote: "\"" | "'" | null = null;
  for (let index = start + 2; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return html.length;
}

interface ConsumedContainer {
  body: string;
  closingTag: string | null;
  end: number;
}

function consumeInactiveContainer(
  html: string,
  opening: HtmlTagToken,
): ConsumedContainer {
  if (opening.name === "plaintext") {
    return { body: html.slice(opening.end), closingTag: null, end: html.length };
  }
  const stack = [opening.name];
  let cursor = opening.end;
  while (cursor < html.length && stack.length > 0) {
    const top = stack.at(-1) as string;
    const next = html.indexOf("<", cursor);
    if (next < 0) break;
    if (html.startsWith("<!--", next) && !RAW_TEXT_CONTAINERS.has(top)) {
      const close = html.indexOf("-->", next + 4);
      cursor = close < 0 ? html.length : close + 3;
      continue;
    }
    if (!RAW_TEXT_CONTAINERS.has(top) && (html.startsWith("<!", next) || html.startsWith("<?", next))) {
      cursor = declarationEnd(html, next);
      continue;
    }
    const token = tagAt(html, next);
    if (!token) {
      cursor = next + 1;
      continue;
    }
    if (RAW_TEXT_CONTAINERS.has(top)) {
      if (!token.closing || token.name !== top) {
        cursor = token.end;
        continue;
      }
      stack.pop();
    } else if (token.closing) {
      if (token.name === top) stack.pop();
    } else if (INACTIVE_CONTAINERS.has(token.name)) {
      // HTML ignores the self-closing flag on these non-void elements.
      stack.push(token.name);
      if (token.name === "plaintext") {
        cursor = html.length;
        break;
      }
    }
    cursor = token.end;
    if (stack.length === 0) {
      return {
        body: html.slice(opening.end, token.start),
        closingTag: token.source,
        end: token.end,
      };
    }
  }
  return { body: html.slice(opening.end), closingTag: null, end: html.length };
}

function scriptIsJsonLd(attributes: string): boolean {
  const type = attributes.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return (type?.[1] ?? type?.[2] ?? type?.[3] ?? "").trim().toLocaleLowerCase("en-US")
    === "application/ld+json";
}

/**
 * Preserve one genuine tag boundary while neutralizing markup-looking bytes
 * inside its attributes. Downstream bounded extractors intentionally use small
 * regexes over this projection; without this normalization, a quoted value
 * such as `data-note=\">forged text\"` could terminate those regexes early and
 * be reinterpreted as page text or another declaration. An unterminated tag
 * discards its uncertain suffix.
 */
function projectedTagSource(source: string): string {
  if (!source.startsWith("<") || !source.endsWith(">")) return " ";
  const body = source.slice(1, -1)
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<${body}>`;
}

/**
 * Produce all passive HTML surfaces in one stateful pass. Raw-text/RCDATA
 * containers recognize only their own end tag; nested inactive containers use
 * a strict stack; malformed/unclosed blocks consume the uncertain suffix.
 */
export function projectInertHtml(html: string): InertHtmlProjection {
  let passiveHtml = "";
  let resourceHtml = "";
  let structuralHtml = "";
  let titleHtml = "";
  const jsonLdBlocks: string[] = [];
  let cursor = 0;

  const appendActive = (value: string) => {
    passiveHtml += value;
    resourceHtml += value;
    structuralHtml += value;
  };

  while (cursor < html.length) {
    const next = html.indexOf("<", cursor);
    if (next < 0) {
      appendActive(html.slice(cursor));
      break;
    }
    appendActive(html.slice(cursor, next));
    if (html.startsWith("<!--", next)) {
      const close = html.indexOf("-->", next + 4);
      if (close < 0) break;
      appendActive(" ");
      cursor = close + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      cursor = declarationEnd(html, next);
      appendActive(" ");
      continue;
    }
    const token = tagAt(html, next);
    if (!token) {
      appendActive("<");
      cursor = next + 1;
      continue;
    }
    if (token.closing || !INACTIVE_CONTAINERS.has(token.name)) {
      appendActive(projectedTagSource(token.source));
      cursor = token.end;
      continue;
    }

    const consumed = consumeInactiveContainer(html, token);
    const openingTag = projectedTagSource(token.source);
    const closingTag = consumed.closingTag
      ? projectedTagSource(consumed.closingTag)
      : "";
    if (token.name === "script" || token.name === "iframe") {
      resourceHtml += `${openingTag} `;
    }
    structuralHtml += `${openingTag} `;
    if (token.name === "title") {
      titleHtml += `${openingTag}${consumed.body}${closingTag} `;
    } else if (token.name === "script" && scriptIsJsonLd(token.attributes)) {
      jsonLdBlocks.push(`${openingTag}${consumed.body}${closingTag}`);
    }
    passiveHtml += " ";
    resourceHtml += " ";
    structuralHtml += " ";
    cursor = consumed.end;
  }

  return {
    passiveHtml,
    resourceHtml,
    structuralHtml,
    titleHtml,
    jsonLdHtml: jsonLdBlocks.join("\n"),
  };
}

/** Remove HTML comments. An unterminated comment discards the uncertain suffix. */
export function stripHtmlComments(html: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<!--", cursor);
    if (start < 0) return output + html.slice(cursor);
    output += html.slice(cursor, start);
    const close = html.indexOf("-->", start + 4);
    if (close < 0) return output;
    output += " ";
    cursor = close + 3;
  }
  return output;
}

/**
 * Replace every outer container of one tag name using a depth-aware scan.
 * Nested same-name containers are consumed with their outer parent. If a
 * bounded response ends before the matching close tag, the uncertain suffix
 * belongs to that block and never gets reinterpreted as active markup.
 */
export function replaceHtmlContainers(
  html: string,
  tagName: string,
  replacement: (block: HtmlContainerBlock) => string,
): string {
  const normalizedTag = tagName.toLocaleLowerCase("en-US");
  const tokens = scanTags(html).filter((token) => token.name === normalizedTag);
  let output = "";
  let cursor = 0;
  let depth = 0;
  let opening: HtmlTagToken | null = null;

  for (const token of tokens) {
    if (depth === 0) {
      if (token.closing) continue;
      output += html.slice(cursor, token.start);
      // HTML's plaintext tokenizer state has no closing-tag transition. A
      // literal </plaintext> is text, so the first opening tag consumes the
      // entire bounded suffix even when it looks self-closing.
      if (normalizedTag === "plaintext") {
        output += replacement({
          tagName: normalizedTag,
          openingTag: token.source,
          attributes: token.attributes,
          body: html.slice(token.end),
          closingTag: null,
          selfClosing: false,
        });
        return output;
      }
      if (token.selfClosing) {
        output += replacement({
          tagName: normalizedTag,
          openingTag: token.source,
          attributes: token.attributes,
          body: "",
          closingTag: null,
          selfClosing: true,
        });
        cursor = token.end;
        continue;
      }
      opening = token;
      depth = 1;
      continue;
    }
    if (!token.closing) {
      if (!token.selfClosing) depth += 1;
      continue;
    }
    depth -= 1;
    if (depth !== 0 || !opening) continue;
    output += replacement({
      tagName: normalizedTag,
      openingTag: opening.source,
      attributes: opening.attributes,
      body: html.slice(opening.end, token.start),
      closingTag: token.source,
      selfClosing: false,
    });
    cursor = token.end;
    opening = null;
  }

  if (depth > 0 && opening) {
    output += replacement({
      tagName: normalizedTag,
      openingTag: opening.source,
      attributes: opening.attributes,
      body: html.slice(opening.end),
      closingTag: null,
      selfClosing: false,
    });
    cursor = html.length;
  }
  return output + html.slice(cursor);
}
