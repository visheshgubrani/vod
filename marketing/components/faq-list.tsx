"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

type FaqItem = {
  question: string;
  answer: string;
};

export function FaqList({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  return (
    <div className="divide-y divide-hairline border-y border-hairline">
      {items.map((item, index) => (
        <details
          key={item.question}
          className="faq-item group"
          onToggle={(event) => {
            setOpenIndex(event.currentTarget.open ? index : null);
          }}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-5 text-left text-[17px] font-semibold tracking-[-0.03em] [&::-webkit-details-marker]:hidden">
            {item.question}
            <span className="faq-plus relative size-5 shrink-0 text-violet" aria-hidden="true" />
          </summary>
          <AnimatePresence initial={false}>
            {openIndex === index ? (
              <motion.div
                className="max-w-2xl overflow-hidden pr-10"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
              >
                <p className="pb-5 text-[15px] leading-7 text-muted">{item.answer}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <noscript>
            <p className="max-w-2xl pb-5 pr-10 text-[15px] leading-7 text-muted">{item.answer}</p>
          </noscript>
        </details>
      ))}
    </div>
  );
}
