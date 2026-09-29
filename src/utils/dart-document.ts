import { unzipSync } from "fflate";
import { DartApiError } from "./dart-client.js";

const DOCUMENT_URL = "https://opendart.fss.or.kr/api/document.xml";
const TIMEOUT_MS = 60_000;

/** 공시서류 원본파일(document.xml)을 받아 ZIP을 풀고 XML 텍스트로 합친다. */
export async function fetchDocumentXml(rceptNo: string): Promise<string> {
  const key = process.env.DART_API_KEY;
  if (!key) {
    throw new Error("환경변수 DART_API_KEY가 설정되지 않았습니다.");
  }

  const url = new URL(DOCUMENT_URL);
  url.searchParams.set("crtfc_key", key);
  url.searchParams.set("rcept_no", rceptNo);

  let buffer: ArrayBuffer;
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new DartApiError(
        String(response.status),
        `DART 원문 API HTTP 오류: ${response.status} ${response.statusText}`,
      );
    }
    buffer = await response.arrayBuffer();
  } catch (error) {
    if (error instanceof DartApiError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new DartApiError("TIMEOUT", "DART 원문 요청이 60초를 초과했습니다.");
    }
    throw new DartApiError(
      "NETWORK",
      `DART 원문 네트워크 오류: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const bytes = new Uint8Array(buffer);

  // ZIP이 아니면 DART가 XML 에러 응답을 준 것이다.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    const text = decodeKorean(bytes).slice(0, 500);
    const status = /<status>(\d+)<\/status>/.exec(text)?.[1];
    const message = /<message>([^<]*)<\/message>/.exec(text)?.[1];
    throw new DartApiError(
      status ?? "UNKNOWN",
      message
        ? `DART 원문 조회 실패: ${message} (접수번호 ${rceptNo})`
        : `DART 원문 응답이 ZIP이 아닙니다: ${text}`,
    );
  }

  const files = unzipSync(bytes);
  const names = Object.keys(files).filter((n) => n.toLowerCase().endsWith(".xml"));
  if (names.length === 0) {
    throw new DartApiError("EMPTY", "원문 ZIP 안에 XML 파일이 없습니다.");
  }

  return names
    .sort()
    .map((n) => decodeKorean(files[n]))
    .join("\n");
}

/** DART 원문은 UTF-8이 대부분이나 오래된 공시는 EUC-KR인 경우가 있다. */
function decodeKorean(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  "&cr;": "\n",
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&cr;|&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** TABLE 요소를 파이프 구분 텍스트로 바꾼다 (숫자 표를 읽을 수 있게). */
function tableToText(tableXml: string): string {
  const rows: string[] = [];
  for (const rowMatch of tableXml.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(
      /<T[HD][^>]*>([\s\S]*?)<\/T[HD]>/gi,
    )) {
      cells.push(inlineText(cellMatch[1]));
    }
    if (cells.some((c) => c !== "")) {
      rows.push("| " + cells.join(" | ") + " |");
    }
  }
  return rows.join("\n");
}

/** 태그를 제거하고 공백을 정리한 한 줄 텍스트. */
function inlineText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/**
 * 원문 XML 조각을 사람이 읽을 수 있는 텍스트로 변환한다.
 * 표는 파이프 구분 행으로, 문단은 줄바꿈으로 남긴다.
 */
export function xmlToReadableText(xml: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  // 표는 따로 변환하고, 표 사이의 문단은 일반 텍스트로 처리한다.
  for (const match of xml.matchAll(/<TABLE[^>]*>[\s\S]*?<\/TABLE>/gi)) {
    const start = match.index ?? 0;
    chunks.push(paragraphText(xml.slice(cursor, start)));
    chunks.push(tableToText(match[0]));
    cursor = start + match[0].length;
  }
  chunks.push(paragraphText(xml.slice(cursor)));

  return chunks
    .filter((c) => c.trim() !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function paragraphText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<(P|BR|TITLE|PGBRK|TE|TU)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

export interface DocumentSection {
  /** 목차에 보이는 이름 (예: "주석", "독립된 감사인의 감사보고서") */
  title: string;
  start: number;
  end: number;
}

/** <TITLE> 기준으로 문서를 대분류 구획으로 나눈다. */
export function splitSections(xml: string): DocumentSection[] {
  const marks: Array<{ title: string; start: number }> = [];
  for (const match of xml.matchAll(/<TITLE[^>]*>([\s\S]*?)<\/TITLE>/gi)) {
    const title = inlineText(match[1]);
    if (title !== "") {
      marks.push({ title, start: match.index ?? 0 });
    }
  }
  return marks.map((mark, i) => ({
    title: mark.title,
    start: mark.start,
    end: i + 1 < marks.length ? marks[i + 1].start : xml.length,
  }));
}

export interface NoteItem {
  /** 주석 번호 (예: "12") */
  number: string;
  /** 주석 제목 (예: "무형자산") */
  title: string;
  start: number;
  end: number;
}

/**
 * 주석 블록 안에서 "숫자." 로 시작하는 문단을 항목 경계로 삼는다.
 * 제목과 본문이 한 문단에 붙어 있는 공시가 많아 제목만 잘라낸다.
 */
export function splitNotes(notesXml: string, offset: number): NoteItem[] {
  const marks: Array<{ number: string; title: string; start: number }> = [];

  for (const match of notesXml.matchAll(/<P[^>]*>([\s\S]*?)<\/P>/gi)) {
    const text = decodeEntities(match[1].replace(/<[^>]+>/g, ""))
      .replace(/[ \t]+/g, " ")
      .trim();
    const heading = /^(\d{1,2})\s*[.．]\s*(\S[^\n]*)/.exec(text);
    if (!heading) continue;

    const title = trimNoteTitle(heading[2]);
    if (title === "") continue;

    marks.push({
      number: heading[1],
      title,
      start: (match.index ?? 0) + offset,
    });
  }

  return marks.map((mark, i) => ({
    number: mark.number,
    title: mark.title,
    start: mark.start,
    end: i + 1 < marks.length ? marks[i + 1].start : offset + notesXml.length,
  }));
}

/**
 * 제목 뒤에 본문이 곧바로 이어붙은 경우를 잘라낸다.
 * "무형자산" 은 그대로, "리스(1) 당기말 및..." 은 "리스" 로.
 */
function trimNoteTitle(raw: string): string {
  let title = raw.split(/\(\d+\)|\(이하|\d{4}년/)[0];
  title = title.split(/당기말|전기말|당사는|당기 중|주식회사|다음과 같습니다/)[0];
  title = title.replace(/\s+/g, " ").trim();
  return title.length > 30 ? title.slice(0, 30).trim() : title;
}
