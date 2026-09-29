import { z } from "zod";
import type { FastMCP } from "fastmcp";
import {
  fetchDocumentXml,
  splitSections,
  splitNotes,
  xmlToReadableText,
  type NoteItem,
} from "../utils/dart-document.js";

const DEFAULT_MAX_CHARS = 15_000;
const KEYWORD_CONTEXT = 600;
const MAX_KEYWORD_HITS = 8;

function findNotesBlock(xml: string) {
  const sections = splitSections(xml);
  const notes = sections.find((s) => s.title.replace(/\s/g, "") === "주석");
  return { sections, notes };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n\n… [${text.length.toLocaleString()}자 중 ${maxChars.toLocaleString()}자만 표시했습니다. ` +
    `keyword 를 지정하거나 section 을 더 좁혀서 다시 조회하세요.]`
  );
}

/** 목차 모드: 문서 구획과 주석 항목 목록을 돌려준다. */
function renderToc(xml: string, rceptNo: string): string {
  const { sections, notes } = findNotesBlock(xml);
  const lines = [
    `접수번호 ${rceptNo} — 문서 목차 (총 ${xml.length.toLocaleString()}자)`,
    "─".repeat(50),
    "[문서 구획] section 인자에 이름을 그대로 넣으세요",
  ];

  for (const section of sections) {
    const size = (section.end - section.start).toLocaleString();
    lines.push(`  · ${section.title} (${size}자)`);
  }

  if (!notes) {
    lines.push("");
    lines.push("주석 구획을 찾지 못했습니다. keyword 로 검색하세요.");
    return lines.join("\n");
  }

  const items = splitNotes(xml.slice(notes.start, notes.end), notes.start);
  lines.push("");
  lines.push(`[주석 항목 ${items.length}개] section 인자에 번호만 넣으세요 (예: "12")`);
  for (const item of items) {
    const size = (item.end - item.start).toLocaleString();
    lines.push(`  ${item.number}. ${item.title} (${size}자)`);
  }

  return lines.join("\n");
}

function renderNote(item: NoteItem, xml: string, maxChars: number): string {
  const body = xmlToReadableText(xml.slice(item.start, item.end));
  return [
    `주석 ${item.number}. ${item.title}`,
    "─".repeat(50),
    truncate(body, maxChars),
  ].join("\n");
}

/** section 모드: 주석 번호 또는 구획 이름으로 본문을 돌려준다. */
function renderSection(
  xml: string,
  section: string,
  maxChars: number,
): string {
  const { sections, notes } = findNotesBlock(xml);
  const wanted = section.trim();

  // 숫자면 주석 항목 번호로 본다.
  if (/^\d{1,2}$/.test(wanted)) {
    if (!notes) return "주석 구획을 찾지 못했습니다. keyword 로 검색하세요.";
    const items = splitNotes(xml.slice(notes.start, notes.end), notes.start);
    const item = items.find((i) => i.number === wanted);
    if (!item) {
      const available = items.map((i) => i.number).join(", ");
      return `주석 ${wanted}번을 찾지 못했습니다. 있는 번호: ${available}`;
    }
    return renderNote(item, xml, maxChars);
  }

  // 그 외에는 구획 이름으로 본다 (부분일치).
  const normalized = wanted.replace(/\s/g, "");
  const match =
    sections.find((s) => s.title.replace(/\s/g, "") === normalized) ??
    sections.find((s) => s.title.replace(/\s/g, "").includes(normalized));

  if (!match) {
    const available = sections.map((s) => s.title).join(" | ");
    return `"${wanted}" 구획을 찾지 못했습니다. 있는 구획: ${available}`;
  }

  const body = xmlToReadableText(xml.slice(match.start, match.end));
  return [match.title, "─".repeat(50), truncate(body, maxChars)].join("\n");
}

/** keyword 모드: 키워드가 나오는 대목을 앞뒤 문맥과 함께 돌려준다. */
function renderKeyword(
  xml: string,
  keyword: string,
  maxChars: number,
): string {
  const { notes } = findNotesBlock(xml);
  const items = notes
    ? splitNotes(xml.slice(notes.start, notes.end), notes.start)
    : [];

  const text = xmlToReadableText(xml);
  const needle = keyword.trim();
  const hits: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1 && hits.length < MAX_KEYWORD_HITS) {
    hits.push(index);
    index = text.indexOf(needle, index + needle.length + KEYWORD_CONTEXT);
  }

  if (hits.length === 0) {
    return `"${needle}" 를 문서에서 찾지 못했습니다.`;
  }

  const lines = [
    `"${needle}" 검색 결과 ${hits.length}곳${hits.length === MAX_KEYWORD_HITS ? " (상한 도달)" : ""}`,
    "─".repeat(50),
  ];

  for (const hit of hits) {
    const from = Math.max(0, hit - KEYWORD_CONTEXT / 2);
    const to = Math.min(text.length, hit + KEYWORD_CONTEXT);
    lines.push(`…${text.slice(from, to).trim()}…`);
    lines.push("");
  }

  if (items.length > 0) {
    lines.push(
      `[참고] 주석 항목: ${items.map((i) => `${i.number}.${i.title}`).join(" / ")}`,
    );
    lines.push("특정 주석 전문이 필요하면 section 에 번호를 넣어 다시 조회하세요.");
  }

  return truncate(lines.join("\n"), maxChars);
}

async function executeGetDocument(args: {
  rcept_no: string;
  section?: string;
  keyword?: string;
  max_chars?: number;
}): Promise<string> {
  const rceptNo = args.rcept_no.replace(/\D/g, "");
  if (rceptNo.length !== 14) {
    return `접수번호는 14자리 숫자입니다 (받은 값: ${args.rcept_no}). search_disclosures 결과의 접수번호를 사용하세요.`;
  }

  const xml = await fetchDocumentXml(rceptNo);
  const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;

  if (args.keyword) return renderKeyword(xml, args.keyword, maxChars);
  if (args.section) return renderSection(xml, args.section, maxChars);
  return renderToc(xml, rceptNo);
}

export function registerDocumentTools(server: FastMCP) {
  server.addTool({
    name: "get_disclosure_document",
    description:
      "공시서류 원문 조회 — 감사보고서·사업보고서의 재무제표 주석 전문을 읽습니다 " +
      "(Read the full text of a DART filing, including notes to financial statements). " +
      "주석 / 각주 / 회계정책 / 무형자산·리스·특수관계자거래·우발부채 등 개별 주석 내용, " +
      "감사의견, K-IFRS 적용 여부를 확인할 때 씁니다. " +
      "접수번호는 search_disclosures 로 먼저 찾으세요. " +
      "인자 없이 호출하면 목차를 주고, 거기서 원하는 주석 번호를 section 에 넣어 다시 부르는 방식입니다.",
    parameters: z.object({
      rcept_no: z
        .string()
        .describe(
          "접수번호 14자리 (search_disclosures 결과의 rcept_no). 예: 20260324000136",
        ),
      section: z
        .string()
        .optional()
        .describe(
          '주석 번호("12") 또는 구획 이름("주석", "독립된 감사인의 감사보고서"). ' +
            "생략하면 목차를 반환합니다.",
        ),
      keyword: z
        .string()
        .optional()
        .describe(
          '키워드로 문서 전체를 검색해 해당 대목만 문맥과 함께 반환 (예: "리스", "정액법"). ' +
            "section 보다 우선합니다.",
        ),
      max_chars: z
        .number()
        .min(1_000)
        .max(60_000)
        .optional()
        .describe("반환 최대 글자 수. 기본 15000."),
    }),
    execute: async (args) => executeGetDocument(args),
  });
}
