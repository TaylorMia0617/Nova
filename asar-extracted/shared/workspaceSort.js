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

const chineseSectionUnits = new Map([
  ["十", 10],
  ["百", 100],
  ["千", 1000],
]);

const chineseLargeUnits = new Map([
  ["万", 10000],
  ["亿", 100000000],
]);

const sortableNumberChars = "0-9零一二两三四五六七八九十百千万亿";
const chapterPattern = new RegExp(`^第\\s*([${sortableNumberChars}]+)\\s*[章节回部集卷篇]`);
const leadingNumberPattern = new RegExp(`^([${sortableNumberChars}]+)`);

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

    if (chineseSectionUnits.has(char)) {
      section += (number || 1) * (chineseSectionUnits.get(char) ?? 1);
      number = 0;
      continue;
    }

    if (chineseLargeUnits.has(char)) {
      const unit = chineseLargeUnits.get(char) ?? 1;
      total += (section + number || 1) * unit;
      section = 0;
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
