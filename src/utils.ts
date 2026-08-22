/**
 * Utility functions for Educational Architect
 */

// Simple markup formatter supporting bold (**text**), italics (*text*), backticks (`code`), line breaks, headings, and list bullets
export function formatMarkdown(text: string | undefined): string {
  if (!text) return "";
  
  // Escape HTML to prevent injection and raw tag confusion
  let formatted = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Support simple Markdown headers: ### Heading, ## Heading, # Heading
  formatted = formatted.replace(/^\s*###\s+(.*?)$/gm, "<h4 class='text-sm font-bold text-indigo-300 mt-3 mb-1'>$1</h4>");
  formatted = formatted.replace(/^\s*##\s+(.*?)$/gm, "<h3 class='text-base font-bold text-indigo-400 mt-4 mb-1.5'>$1</h3>");
  formatted = formatted.replace(/^\s*#\s+(.*?)$/gm, "<h2 class='text-lg font-bold text-white mt-5 mb-2'>$1</h2>");

  // Bold
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  // Italics
  formatted = formatted.replace(/\*(.*?)\*/g, "<em>$1</em>");

  // Code backticks
  formatted = formatted.replace(/`(.*?)`/g, "<code class='font-mono bg-white/10 px-1 py-0.5 rounded text-teal-300'>$1</code>");

  // Bullet points
  formatted = formatted.replace(/^\s*[-*]\s+(.*?)$/gm, "<li class='ml-4 list-disc text-slate-200'>$1</li>");

  // Line breaks
  formatted = formatted.replace(/\n/g, "<br />");

  return formatted;
}

// Debounce helper for auto-saving drafts without blocking UI rendering
export function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  return function(...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

// Custom simple parser to detect junk entries
export function detectGibberish(str: string | undefined): boolean {
  if (!str) return true;
  const t = str.trim().toLowerCase();
  const cleanT = t.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").trim(); 
  
  // Pattern for giving up easily
  const rinuncePattern = /^(?:(?:no(n)?|nn)\s*(?:lo\s*)?so|boh+|bho+|bo+|(?:no(n)?|nn)\s*saprei|(?:no(n)?|nn)\s*(?:mi\s*)?ricordo|niente|nessuna|(?:no(n)?|nn)\s*h?o\s*studiato|(?:no(n)?|nn)\s*(?:l')?h?o\s*capit[oa]|(?:no(n)?|nn)\s*capisco|(?:no(n)?|nn)\s*h?o\s*idea|(?:no(n)?|nn)\s*ne\s*ho\s*idea|non\s*saprei\s*proprio|ma\s*che\s*ne\s*so|boh|non\s*lo\s*so\s*proprio|mi\s*sa\s*di\s*cavolata|non\s*serve\s*a\s*niente|non\s*so\s*nulla)$/i;
  
  if (rinuncePattern.test(cleanT)) return true;
  
  // If we reach here, it's not obviously empty or a give up string.
  // The Gemini prompt already explicitly instructs it to give a 0 for keyboard mashing
  // or incoherent answers, so we rely on the GenAI evaluation instead of aggressive manual regexes
  // that can easily cause false positives (e.g. typos, foreign words, symbols).
  return false;
}

// Fetch helper with automatic retry for transient network/server-warmup issues
export async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2, delayMs = 1000): Promise<Response> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      lastError = new Error(text || `Richiesta fallita con codice di stato HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    if (i < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Richiesta fallita dopo diversi tentativi.");
}
