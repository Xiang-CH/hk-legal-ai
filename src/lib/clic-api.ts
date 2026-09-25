// Single import entry for the chat API helper module.
// This is the ONLY source file that references the helper's physical
// route-folder path — everything else imports from here. A future base-path
// move therefore touches this file plus src/lib/routes.ts and the folder
// names on disk, nothing else.
export * from "@/app/clic-chat-hkulaw/api/chat/helper";
