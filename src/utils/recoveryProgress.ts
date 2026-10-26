/**
 * Avanzamento della richiesta di un piano di recupero.
 *
 * Il server accoda i piani in una corsia dedicata (`RECOVERY_CONCURRENCY`
 * lavoratori): con tutta la classe che li chiede insieme lo studente può
 * aspettare qualche minuto. Qui si traducono stato e posizione in due testi
 * brevi da mostrare accanto al pulsante, così sa quanto deve aspettare.
 */
export interface RecoveryProgress {
  status: "queued" | "processing";
  /** Posto in coda: 1 = tocca a te (0 o valori assenti vengono trattati come 1). */
  position: number;
}

/** Secondi di attesa stimati per ogni piano davanti (generazione IA ~10 s, 2 posti). */
const SECONDS_PER_PLAN_AHEAD = 6;

/** Testo breve, da mettere dentro il pulsante. */
export function recoveryProgressLabel(progress: RecoveryProgress | null): string {
  if (!progress) return "Invio della richiesta…";
  if (progress.status === "processing") return "Scrivo il piano…";
  if (progress.position <= 1) return "In coda: tocca a te…";
  return `In coda: ${progress.position}° posto`;
}

/** Frase esplicativa sotto il pulsante: quanti piani davanti e quanto si aspetta. */
export function recoveryProgressHint(progress: RecoveryProgress | null): string {
  if (!progress) return "Richiesta inviata, attendo la conferma del server…";
  if (progress.status === "processing") return "L'IA sta scrivendo il tuo piano: pochi secondi…";
  if (progress.position <= 1) return "Sei il prossimo della coda: parte tra pochi secondi…";
  const ahead = progress.position - 1;
  const minutes = Math.max(1, Math.round((ahead * SECONDS_PER_PLAN_AHEAD) / 60));
  const plans = ahead === 1 ? "1 piano" : `${ahead} piani`;
  return `Hai ${plans} davanti al tuo · attesa stimata ~${minutes} ${minutes === 1 ? "minuto" : "minuti"}`;
}

/** Percentuale (8-100) usata dalla barretta: si avvicina a 100 quando tocca a te. */
export function recoveryProgressPercent(progress: RecoveryProgress | null): number {
  if (!progress || progress.status === "processing") return 100;
  return Math.max(8, Math.min(100, 100 - (progress.position - 1) * 5));
}
