/**
 * Pulizia del testo delle domande importate.
 *
 * L'app aggiunge già il proprio numero davanti a ogni domanda, quindi un titolo
 * Google Moduli del tipo "12. Qual è…" produrrebbe "12. 12. Qual è…". Si toglie
 * solo un numero iniziale di 1-3 cifre seguito da un separatore: "12 marzo 2020"
 * e "2024. Bilancio" restano intatti.
 */
export function stripQuestionNumbering(text: string): string {
  const value = (text || "").trim();
  const cleaned = value.replace(/^\d{1,3}\s*[.)\-–—:]\s+/, "").trim();
  return cleaned || value;
}
