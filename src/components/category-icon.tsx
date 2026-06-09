import {
  Boxes,
  Briefcase,
  CalendarDays,
  CarFront,
  ContactRound,
  FileText,
  HeartPulse,
  ImageIcon,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { CategoryIconName } from "@/lib/categories";

const ICONS: Record<CategoryIconName, LucideIcon> = {
  "user-round": UserRound,
  "contact-round": ContactRound,
  "heart-pulse": HeartPulse,
  wallet: Wallet,
  calendar: CalendarDays,
  image: ImageIcon,
  briefcase: Briefcase,
  "car-front": CarFront,
  "file-text": FileText,
  boxes: Boxes,
};

/** Resolve a category's icon-name token to its Lucide component. */
export function categoryIcon(name: CategoryIconName): LucideIcon {
  return ICONS[name] ?? Boxes;
}
