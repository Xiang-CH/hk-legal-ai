import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";

export default function Page() {
  redirect(routes.chat);
}
