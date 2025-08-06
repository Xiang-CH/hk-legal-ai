import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskSource {
  task_name: string;
  task_description: string;
  task_sources: string[];
  task_completed: boolean;
}

interface TasksData {
  tasks: TaskSource[];
}

interface TaskDisplayProps {
  tasks: TasksData | null;
  onTaskStatusChange?: (updatedTasks: TasksData) => void;
}

export function TaskDisplay({ tasks, onTaskStatusChange }: TaskDisplayProps) {
  const [openTasks, setOpenTasks] = useState<Record<string, boolean>>({});

  if (!tasks) return null;

  const toggleTask = (taskName: string) => {
    setOpenTasks(prev => ({
      ...prev,
      [taskName]: !prev[taskName]
    }));
  };

  const toggleTaskStatus = (taskName: string) => {
    if (!tasks || !onTaskStatusChange) return;
    
    const updatedTasks = tasks.tasks.map(task => 
      task.task_name === taskName 
        ? { ...task, task_completed: !task.task_completed } 
        : task
    );
    
    onTaskStatusChange({
      ...tasks,
      tasks: updatedTasks
    });
  };

  // const getTaskStatus = (taskName: string): boolean => {
  //   const task = tasks.tasks.find(t => t.task_name === taskName);
  //   return task?.task_completed || false;
  // };

  return (
    <div className="space-y-3 w-full">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-semibold">Consultation Tasks</h3>
        <div className="text-xs text-muted-foreground">
          {tasks.tasks.filter(t => t.task_completed).length}/{tasks.tasks.length} completed
        </div>
      </div>
      
      {tasks.tasks.map((task) => (
        <Collapsible 
          key={task.task_name}
          open={openTasks[task.task_name]}
          className={cn(
            "border rounded-lg overflow-hidden transition-all",
            task.task_completed 
              ? "bg-muted/30 border-muted" 
              : "bg-card border-border"
          )}
        >
          <div className="flex items-center p-3 gap-2">
            <Checkbox 
              checked={task.task_completed}
              onCheckedChange={() => toggleTaskStatus(task.task_name)}
              className="h-5 w-5"
            />
            
            <div className="flex-1 font-medium text-sm">
              {task.task_name}
            </div>
            
            <CollapsibleTrigger asChild onClick={() => toggleTask(task.task_name)}>
              <Button variant="ghost" size="sm" className="p-1 h-7 w-7">
                {openTasks[task.task_name] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </Button>
            </CollapsibleTrigger>
          </div>
          
          <CollapsibleContent>
            <div className="px-4 pb-3 pt-0">
              <p className="text-sm">{task.task_description}</p>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Sources:</h4>
              <ul className="text-xs space-y-1 pl-5 list-disc">
                {task.task_sources.map((source, idx) => (
                  <li key={idx}>{source}</li>
                ))}
              </ul>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
