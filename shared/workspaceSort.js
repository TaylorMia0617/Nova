const naturalNameCollator = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

const chineseDigitMap = new Map([
  ["零", 0],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
]);

const chapterPattern = /^第\s*([0-9零一二两三四五六七八九十百千]+)\s*[章节回部集卷篇]/;
const leadingNumberPattern = /^([0-9零一二两三四五六七八九十百千]+)/;

export function parseChineseNumber(input) {
  if (!input) return null;
  if (/^\d+$/.test(input)) return Number(input);

  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of input) {
    if (chineseDigitMap.has(char)) {
      number = chineseDigitMap.get(char) ?? 0;
      continue;
    }

    if (char === "十") {
      section += (number || 1) * 10;
      number = 0;
      continue;
    }

    if (char === "百") {
      section += (number || 1) * 100;
      number = 0;
      continue;
    }

    if (char === "千") {
      section += (number || 1) * 1000;
      number = 0;
      continue;
    }

    return null;
  }

  total += section + number;
  return Number.isFinite(total) ? total : null;
}

export function extractSortableNumber(name) {
  const normalizedName = name.replace(/\.[^.]+$/, "").trim();
  const chapterMatch = normalizedName.match(chapterPattern);
  if (chapterMatch) {
    return parseChineseNumber(chapterMatch[1]);
  }

  const leadingNumberMatch = normalizedName.match(leadingNumberPattern);
  if (leadingNumberMatch) {
    return parseChineseNumber(leadingNumberMatch[1]);
  }

  return null;
}

export function compareNodeNames(leftName, rightName) {
  const leftNumber = extractSortableNumber(leftName);
  const rightNumber = extractSortableNumber(rightName);

  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  if (leftNumber !== null && rightNumber === null) return -1;
  if (leftNumber === null && rightNumber !== null) return 1;

  return naturalNameCollator.compare(leftName, rightName);
}
