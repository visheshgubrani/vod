"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

type FaqItem = {
  question: string;
  answer: string;
};

/**
 * Native `<details>` for the open/close semantics, with the answer also
 * rendered inside a `<noscript>` so the page still reads without JavaScript.
 * The client `AnimatePresence` block only adds the height transition.
 */
export function FaqList({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  return (
    <div className="faq-list">
      {items.map((item, index) => (
        <details
          key={item.question}
          className="faq-item"
          onToggle={(event) => {
            setOpenIndex(event.currentTarget.open ? index : null);
          }}
        >
          <summary>
            {item.question}
            <span className="faq-plus" aria-hidden="true" />
          </summary>

          <AnimatePresence initial={false}>
            {openIndex === index ? (
              <motion.div
                className="overflow-hidden"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.18,
                  ease: "easeOut",
                }}
              >
                <p className="faq-answer">{item.answer}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <noscript>
            <p className="faq-answer">{item.answer}</p>
          </noscript>
        </details>
      ))}
    </div>
  );
}
