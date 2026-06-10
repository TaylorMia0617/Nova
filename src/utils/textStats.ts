export type TextStats = {
  characters: number;
  charsNoSpace: number;
  words: number;
  chineseCharacters: number;
  englishWords: number;
  paragraphs: number;
  lines: number;
  readingTime: number;
};

const CHINESE_CHARACTER_PATTERN = /[\p{Script=Han}]/gu;
const ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;
const VISIBLE_CHARACTER_PATTERN = /\S/gu;

export function calculateTextStats(text: string): TextStats {
  const content = text ?? "";
  const trimmed = content.trim();
  const characters = Array.from(content.matchAll(VISIBLE_CHARACTER_PATTERN)).length;
  const chineseCharacters = Array.from(content.matchAll(CHINESE_CHARACTER_PATTERN)).length;
  const englishWords = Array.from(content.matchAll(ENGLISH_WORD_PATTERN)).length;
  const words = chineseCharacters + englishWords;
  const paragraphs = trimmed ? trimmed.split(/\n\s*\n/).length : 0;
  const lines = trimmed ? trimmed.split(/\n/).length : 0;
  const readingMinutes = chineseCharacters / 500 + englishWords / 200;

  return {
    characters,
    charsNoSpace: characters,
    words,
    chineseCharacters,
    englishWords,
    paragraphs,
    lines,
    readingTime: words > 0 ? Math.max(1, Math.ceil(readingMinutes)) : 0,
  };
}
