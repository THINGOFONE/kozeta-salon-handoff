import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2, Calendar, ShoppingCart, MessageCircle, ChevronDown, ChevronUp, X, Sparkles, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ChatRequest, ServiceRecommendation, ProductRecommendation } from "@shared/schema";

export interface ChatMessageWithExtras {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  productRecommendations?: ProductRecommendation[];
  recommendations?: ServiceRecommendation[];
}

type ChatContext = 'chat' | 'book' | 'shop';

const SUGGESTED_QUESTIONS: Record<ChatContext, string[]> = {
  chat: [
    "I want a big change",
    "Help me choose a color",
    "What services do you offer?",
    "I have curly hair"
  ],
  book: [
    "I need a haircut",
    "Looking for color services", 
    "Keratin treatment options",
    "Special occasion styling"
  ],
  shop: [
    "Products for dry hair",
    "Color protection shampoo",
    "Styling products for curly hair",
    "Best anti-frizz products"
  ]
};

function getIntroMessage(context: ChatContext): string {
  switch (context) {
    case 'shop':
      return "Hi! I can help you find the perfect products. Tell me about your hair type or what you're looking for!";
    case 'book':
      return "Hello! I can help you find the perfect service. What are you looking for today?";
    default:
      return "Welcome! I'm here to help with services, products, or booking. What can I help you with?";
  }
}

interface FloatingChatDockProps {
  context?: ChatContext;
  onAddToCart?: (product: ProductRecommendation) => void;
  onBookService?: (serviceKey: string, serviceName: string, phorestServiceId?: string) => void;
  onNavigateToShop?: () => void;
  onNavigateToBook?: () => void;
  initialExpanded?: boolean;
  isInline?: boolean;
  externalMessages?: ChatMessageWithExtras[];
  onMessagesChange?: (messages: ChatMessageWithExtras[]) => void;
}

export function FloatingChatDock({ 
  context = 'chat', 
  onAddToCart, 
  onBookService,
  onNavigateToShop,
  onNavigateToBook,
  initialExpanded = false,
  isInline = false,
  externalMessages,
  onMessagesChange
}: FloatingChatDockProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [internalMessages, setInternalMessages] = useState<ChatMessageWithExtras[]>([
    {
      role: "assistant",
      content: getIntroMessage('chat'),
      timestamp: Date.now()
    }
  ]);
  
  // Use external messages if provided, otherwise use internal state
  const messages = externalMessages || internalMessages;
  const setMessages = (updater: ChatMessageWithExtras[] | ((prev: ChatMessageWithExtras[]) => ChatMessageWithExtras[])) => {
    const newMessages = typeof updater === 'function' ? updater(messages) : updater;
    if (onMessagesChange) {
      onMessagesChange(newMessages);
    } else {
      setInternalMessages(newMessages);
    }
  };
  
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMessageWithExtras[]>(messages);
  const isSendingRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const chatMutation = useMutation({
    mutationFn: async ({ userMessage, previousMessages }: { userMessage: string; previousMessages: ChatMessageWithExtras[] }) => {
      // Snapshot the conversation (including this user turn) so each streamed
      // delta can rebuild the full message list. The custom setMessages wrapper
      // reads from a frozen closure, so React's functional-updater pattern can't
      // accumulate deltas here — we rebuild from this snapshot instead.
      const baseMessages: ChatMessageWithExtras[] = [
        ...previousMessages,
        { role: "user", content: userMessage, timestamp: Date.now() }
      ];

      let streamedText = "";
      const renderStreaming = () => {
        setIsStreaming(true);
        setMessages([
          ...baseMessages,
          { role: "assistant", content: streamedText, timestamp: Date.now() }
        ]);
      };
      const finalize = (data: any) => {
        if (!data?.message) return;
        const finalMsg: ChatMessageWithExtras = {
          ...data.message,
          productRecommendations: data.productRecommendations || []
        };
        setMessages([...baseMessages, finalMsg]);
      };

      const response = await apiRequest("POST", "/api/chat", {
        messages: previousMessages.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
        userMessage
      } as ChatRequest);

      if (!response.body) {
        // Fallback: no stream available, parse as JSON.
        const data = await response.json();
        finalize(data);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processEvent = (raw: string) => {
        const line = raw.split("\n").find(l => l.startsWith("data:"));
        if (!line) return;
        const json = line.slice(5).trim();
        if (!json) return;
        let event: any;
        try {
          event = JSON.parse(json);
        } catch {
          return;
        }
        if (event.type === "delta") {
          streamedText += event.text || "";
          renderStreaming();
        } else if (event.type === "done") {
          finalize(event);
        } else if (event.type === "error") {
          throw new Error(event.message || "stream error");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          processEvent(rawEvent);
        }
      }
      if (buffer.trim()) processEvent(buffer);
    },
    onSettled: () => {
      isSendingRef.current = false;
      setIsStreaming(false);
    },
    onError: () => {
      isSendingRef.current = false;
      setIsStreaming(false);
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "I apologize, but I'm having trouble connecting. Please try again.",
        timestamp: Date.now()
      }]);
    }
  });

  const handleSend = useCallback(() => {
    if (!input.trim() || chatMutation.isPending || isSendingRef.current) return;

    isSendingRef.current = true;
    const userMessage: ChatMessageWithExtras = {
      role: "user",
      content: input.trim(),
      timestamp: Date.now()
    };

    const previousMessagesSnapshot = [...messagesRef.current];
    setMessages(prev => [...prev, userMessage]);
    chatMutation.mutate({ userMessage: input.trim(), previousMessages: previousMessagesSnapshot });
    setInput("");
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, chatMutation]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestedQuestion = (question: string) => {
    setInput(question);
    textareaRef.current?.focus();
  };

  const handleAddToCartClick = (product: ProductRecommendation) => {
    onAddToCart?.(product);
    if (onNavigateToShop && context !== 'shop') {
      onNavigateToShop();
    }
  };

  const handleBookServiceClick = (rec: ServiceRecommendation) => {
    onBookService?.(rec.serviceKey, rec.serviceName, rec.phorestServiceId);
    if (onNavigateToBook && context !== 'book') {
      onNavigateToBook();
    }
  };

  const suggestedQuestions = SUGGESTED_QUESTIONS[context];

  return (
    <div 
      className={`${isInline ? 'absolute' : 'fixed'} bottom-0 left-0 right-0 pointer-events-none`}
      style={{ zIndex: isInline ? 100 : 9999 }}
      data-testid="floating-chat-dock"
    >
      <div className={`${isInline ? 'max-w-full px-3' : 'max-w-2xl mx-auto px-3 sm:px-4'} pb-3 sm:pb-4 pointer-events-auto`}>
        {isExpanded && (
          <div 
            className="bg-card border-2 border-border rounded-t-2xl shadow-2xl mb-0 overflow-hidden animate-in slide-in-from-bottom-4 duration-300"
            style={{ maxHeight: '50vh', minHeight: '280px' }}
            data-testid="chat-popup"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">Kozeta AI</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsExpanded(false)}
                className="h-8 w-8 rounded-full"
                data-testid="button-minimize-chat"
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
            </div>

            <ScrollArea 
              className="p-3 overflow-y-auto"
              style={{ height: 'calc(50vh - 140px)', maxHeight: '200px', minHeight: '100px' }}
              ref={scrollRef}
            >
              <div className="space-y-3">
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    data-testid={`chat-message-${message.role}-${index}`}
                  >
                    <div
                      className={`max-w-[90%] sm:max-w-[85%] rounded-xl px-4 py-2.5 ${
                        message.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted border'
                      }`}
                    >
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>

                      {message.recommendations && message.recommendations.length > 0 && (
                        <div className="mt-2 space-y-2 pt-2 border-t border-current/10">
                          <p className="text-xs font-semibold opacity-90">Recommended:</p>
                          {message.recommendations.slice(0, 2).map((rec, idx) => (
                            <div
                              key={idx}
                              className="rounded-lg p-2 bg-card border space-y-1"
                              data-testid={`service-recommendation-${idx}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <h4 className="font-semibold text-xs text-card-foreground truncate">{rec.serviceName}</h4>
                                  {(rec.duration || rec.price) && (
                                    <p className="text-xs text-muted-foreground">
                                      {rec.duration} {rec.duration && rec.price && '•'} {rec.price}
                                    </p>
                                  )}
                                </div>
                                <Button
                                  size="sm"
                                  onClick={() => handleBookServiceClick(rec)}
                                  className="h-7 px-3 text-xs"
                                  data-testid={`button-book-service-${idx}`}
                                >
                                  <Calendar className="w-3 h-3 mr-1" />
                                  Book
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {message.productRecommendations && message.productRecommendations.length > 0 && (
                        <div className="mt-2 space-y-2 pt-2 border-t border-current/10">
                          <p className="text-xs font-semibold opacity-90">Products:</p>
                          {message.productRecommendations.slice(0, 2).map((product, idx) => (
                            <div
                              key={idx}
                              className="rounded-lg p-2 bg-card border"
                              data-testid={`product-recommendation-${idx}`}
                            >
                              <div className="flex items-center gap-2">
                                <img 
                                  src={product.imageUrl} 
                                  alt={product.name}
                                  className="w-12 h-12 object-cover rounded border flex-shrink-0"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg';
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <h4 className="font-semibold text-xs text-card-foreground truncate">{product.name}</h4>
                                  <p className="text-xs text-muted-foreground">{product.brandName} • ${product.price.toFixed(2)}</p>
                                </div>
                                <Button
                                  size="sm"
                                  onClick={() => handleAddToCartClick(product)}
                                  className="h-7 px-3 text-xs"
                                  disabled={!product.inStock}
                                  data-testid={`button-add-to-cart-${idx}`}
                                >
                                  <ShoppingCart className="w-3 h-3 mr-1" />
                                  Add
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {chatMutation.isPending && !isStreaming && (
                  <div className="flex justify-start">
                    <div className="bg-muted border rounded-lg px-4 py-2.5">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {messages.length === 1 && (
              <div className="px-4 pb-2">
                <div className="flex flex-wrap gap-1.5">
                  {suggestedQuestions.slice(0, 3).map((question, index) => (
                    <button
                      key={index}
                      onClick={() => handleSuggestedQuestion(question)}
                      className="rounded-full border bg-card hover-elevate active-elevate-2 transition-all text-muted-foreground px-3 py-1.5 text-xs"
                      data-testid={`suggested-question-${index}`}
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="p-3 border-t bg-background">
              <div className="flex gap-2 items-end">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message..."
                  className="flex-1 resize-none rounded-lg text-sm border-2 border-input bg-background px-3 py-2.5 focus:border-primary focus:ring-2 focus:ring-primary/20"
                  style={{ minHeight: '44px', maxHeight: '80px' }}
                  rows={1}
                  disabled={chatMutation.isPending}
                  data-testid="input-chat-message"
                />
                <Button
                  onClick={handleSend}
                  disabled={!input.trim() || chatMutation.isPending}
                  size="icon"
                  className="rounded-lg flex-shrink-0"
                  style={{ height: '44px', width: '44px' }}
                  data-testid="button-send-chat"
                >
                  {chatMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div 
          className={`bg-card border-2 border-border shadow-xl flex items-center gap-3 px-4 py-3 cursor-pointer hover-elevate active-elevate-2 transition-all ${
            isExpanded ? 'rounded-b-xl border-t-0' : 'rounded-xl'
          }`}
          onClick={() => !isExpanded && setIsExpanded(true)}
          data-testid="chat-dock-bar"
        >
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-4 h-4 text-primary" />
            </div>
            <span className="text-sm text-muted-foreground truncate">
              {isExpanded ? 'Kozeta AI' : 'Ask Kozeta AI...'}
            </span>
          </div>
          
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="h-8 w-8 rounded-full flex-shrink-0"
            data-testid="button-toggle-chat"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
