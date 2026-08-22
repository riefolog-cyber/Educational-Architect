import { QuizExam, WorkbookExam } from "./types";

export const SAMPLE_QUIZ: QuizExam = {
  title: "Prova di Storia: L'Impero Romano",
  multipleChoice: [
    {
      id: "q1",
      question: "In quale anno venne fondata la città di Roma, secondo la leggenda tradita dalle fonti antiche?",
      options: [
        "753 a.C.",
        "509 a.C.",
        "476 d.C.",
        "27 a.C."
      ],
      correctIndex: 0
    },
    {
      id: "q2",
      question: "Chi fu il primo vero imperatore romano, colui che pose fine alle guerre civili inaugurando il principato?",
      options: [
        "Giulio Cesare",
        "Marco Aurelio",
        "Ottaviano Augusto",
        "Nerone"
      ],
      correctIndex: 2
    },
    {
      id: "q3",
      question: "Quale celebre dinastia imperiale edificò l'Anfiteatro Flavio (noto come Colosseo)?",
      options: [
        "Dinastia Giulio-Claudia",
        "Dinastia Flavia",
        "Dinastia degli Antonini",
        "Dinastia dei Severi"
      ],
      correctIndex: 1
    }
  ],
  openEnded: [
    {
      id: "q4",
      question: "Spiega brevemente quali furono le cause principali della crisi del III secolo d.C. e come l'imperatore Diocleziano cercò di risolverla sul piano politico-amministrativo."
    },
    {
      id: "q5",
      question: "Analizza le conseguenze storiche e sociali dell'Editto di Milano (313 d.C.) emanato da Costantino sulla diffusione del Cristianesimo nell'impero."
    }
  ]
};

export const SAMPLE_WORKBOOK: WorkbookExam = {
  title: "Workbook di Scienze: La Fotosintesi Clorofilliana",
  sections: [
    {
      title: "Il Processo Biochimico",
      sintesi: "La fotosintesi è il processo biochimico fondamentale mediante il quale gli organismi autotrofi (come le piante verdi) catturano l'energia radiante solare per sintetizzare carboidrati a partire da molecole inorganiche semplici.",
      fillInTheBlank: [
        {
          id: "fib1",
          sentence: "Durante la fotosintesi, le piante assorbono l'anidride carbonica attraverso minuscole aperture poste sulle foglie chiamate ___________ ed assorbono l'acqua dal terreno tramite le radici.",
          answer: "stomi, stoma"
        },
        {
          id: "fib2",
          sentence: "Il pigmento deputato a catturare i fotoni solari è la ___________, localizzata all'interno di organelli cellulari specializzati chiamati cloroplasti.",
          answer: "clorofilla"
        }
      ],
      reflectionQuestions: [
        {
          id: "rq1",
          question: "Spiega il ruolo cruciale dell'acqua nella fase luminosa della fotosintesi, focalizzandoti sul concetto di fotolisi e sul rilascio del gas essenziale per la vita."
        }
      ]
    },
    {
      title: "Impatto Ecologico Globale",
      sintesi: "La fotosintesi non provvede solo alla sussistenza delle piante, ma costituisce il motore biogeochimico del pianeta Terra, regolando la composizione dell'atmosfera.",
      fillInTheBlank: [
        {
          id: "fib3",
          sentence: "La reazione complessiva produce glucosio accumulato come riserva energetica e rilascia ___________ molecolare come sottoprodotto essenziale nell'aria.",
          answer: "ossigeno, o2"
        }
      ],
      reflectionQuestions: [
        {
          id: "rq2",
          question: "Metti in relazione l'espansione della deforestazione con il ciclo del carbonio ed il riscaldamento globale, commentando l'importanza delle foreste come sink di carbonio."
        }
      ]
    }
  ],
  answerKey: {
    reflectionCriteria: [
      "Rigore nella terminologia biochimica (fotolisi, cloroplasti, stomi).",
      "Comprensione della correlazione macroscopica tra cicli biologici e riscaldamento climatico.",
      "Profondità argomentativa e nessi logici chiari."
    ]
  }
};
