import { motion } from "framer-motion";
import Link from "next/link";

import { MessageIcon } from "./icons";

export const Overview = () => {
  return (
    <motion.div
      key="overview"
      className="max-w-3xl mx-auto md:mt-20"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ delay: 0.1 }}
    >
      <div className="rounded-xl p-6 flex flex-col gap-8 leading-relaxed text-center max-w-xl">
        <p className="flex flex-row justify-center gap-4 items-center">
          <img src="/clic-logo.gif" width={36} height={36} alt="clic logo"></img>
          <span>+</span>
          <MessageIcon size={32} />
        </p>
        <p>
          CLIC-Chat is an AI system for community legal education that provides
          information about Hong Kong ordinances and legal cases. Ask me anything.
        </p>
        <p className="hidden md:block">
          If you want to read more about the law in Hong Kong, check out  {" "}
          <Link
            className="font-medium underline underline-offset-4"
            href="https://www.clic.org.hk/"
            target="_blank"
          >
            CLIC (Community Legal Information Centre)
          </Link>{" "}
        </p>
      </div>
    </motion.div>
  );
};
