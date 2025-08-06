// "use client";

// import { PreviewMessage, ThinkingMessage } from "@/components/message";
// import { MultimodalInput } from "@/components/multimodal-input";
// import { Overview } from "@/components/overview";
// import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
// import { useDevMode } from "@/hooks/use-dev-mode";
// import { useChat } from '@ai-sdk/react'
// import { useEffect, useState } from "react";
// import { toast } from "sonner";
// import { cn } from "@/lib/utils";
// import { GroundingsDisplay } from "./groundings-display";
// import { TaskDisplay } from "./task-display";
// import { v4 as uuidv4 } from 'uuid';

// export function Consult() {
//   const consultId = "002";
//   const [ searchQuery, setSearchQuery ] = useState<Array<string> | null>(null);
//   const [ groundings, setGroundings ] = useState<any | null>(null);
//   const [ tasks, setTasks ] = useState<any | null>(null);
//   const { isDevMode } = useDevMode();
//   const [ sessionId ] = useState(() => uuidv4());
//   // const sessionId = "001";

//   const {
//     messages,
//     setMessages,
//     handleSubmit,
//     input,
//     setInput,
//     append,
//     isLoading,
//     stop,
//     data
//   } = useChat({
//     id: sessionId,
//     body: { id: sessionId },
//     api: "http://127.0.0.1:8000/api/consult",
//     // api: "https://clic-api.cxiang.site/api/consult",
//     maxSteps: 4,
//     onError: (error) => {
//       if (error.message.includes("Too many requests")) {
//         toast.error(
//           "You are sending too many messages. Please try again later.",
//         );
//       }
//     },
//   });

//   useEffect(() => {
//     return () => {
//       fetch(`http://127.0.0.1:8000/api/exit?id=${sessionId}`)
//     }
//   })

//   const [messagesContainerRef, messagesEndRef] =
//     useScrollToBottom<HTMLDivElement>();

//   useEffect(() => {
//     if (data && data[data.length - 1]) {
//       const dataDict = (data[data.length - 1] as { searchQueries?: Array<string>, groundings?: any, tasks?: any })
//       console.log(dataDict)
//       if (dataDict?.groundings) {
//         setGroundings(dataDict.groundings);
//       } 
//       if (dataDict?.searchQueries) {
//         setSearchQuery(dataDict.searchQueries);
//       }
//       if (dataDict?.tasks) {
//         setTasks(dataDict.tasks);
//       }
//     }
//   }, [data]);

//   return (
//     <div className={cn("flex h-[calc(100dvh-52px)] max-h-[calc(100dvh-52px)]", isDevMode ? "grid grid-cols-[minmax(250px,1fr)_minmax(48rem,1.5fr)_minmax(250px,1fr)] gap-2" : "justify-center")}>
//       {isDevMode && (
//         <div className="col-span-1 p-4 border-r border-border overflow-y-auto h-full">
//           {searchQuery && (
//             <div className="mb-4">
//               <h3 className="font-semibold mb-2">Search Queries</h3>
//               {
//                 searchQuery.map((query, index) => (
//                   <pre key={index} className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">{query}</pre>
//                 ))
//               }
//             </div>
//           )}
//           {isDevMode && groundings && (
//             <div>
//               <h3 className="font-semibold mb-2">Groundings</h3>
//               <GroundingsDisplay groundings={groundings} />
//             </div>
//           )}
//         </div>
//       )}
      
//       <div className={cn("flex flex-col min-w-0 bg-background scrollbar w-full h-full overflow-y-auto", isDevMode ? "col-span-1" : "max-w-3xl")}>
//         <div
//           ref={messagesContainerRef}
//           className="flex flex-col min-w-0 gap-6 flex-1 overflow-y-scroll pt-4"
//         >
//           {messages.length === 0 && <Overview />}

//           {messages.map((message, index) => (
//             <PreviewMessage
//               key={message.id}
//               chatId={consultId}
//               message={message}
//               isLoading={isLoading && messages.length - 1 === index}
//             />
//           ))}

//           {isLoading &&
//             messages.length > 0 &&
//             (messages[messages.length - 1].role === "user" || !messages[messages.length - 1].content ) && <ThinkingMessage query={searchQuery?.join(", ")}/>}

//           <div
//             ref={messagesEndRef}
//             className="shrink-0 min-w-[24px] min-h-[24px]"
//           />
//         </div>

//         <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full max-w-3xl">
//           <MultimodalInput
//             chatId={consultId}
//             input={input}
//             setInput={setInput}
//             handleSubmit={(event) => {
//               handleSubmit(event)
//             }}
//             isLoading={isLoading}
//             stop={stop}
//             messages={messages}
//             setMessages={setMessages}
//             append={append}
//           />
//         </form>
//       </div>
      
//       {isDevMode && (
//         <div className="col-span-1 p-4 border-l border-border overflow-y-auto">
//           {tasks && (
//             <div>
//               <h3 className="font-semibold mb-2">Task Details</h3>
//               {/* <h4 className="text-sm font-medium">All Messages:</h4> */}
//               <TaskDisplay 
//                 tasks={tasks} 
//               />
//             </div>
//           )}
//         </div>
//       )}
//     </div>
//   );
// }
