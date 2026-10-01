import { useState, useRef, useEffect } from "react";
import { Send, Loader2, Calendar, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ChatMessage, ChatRequest, ChatResponse, ServiceRecommendation, ProductRecommendation } from "@shared/schema";

interface ChatMessageWithProducts extends ChatMessage {
  productRecommendations?: ProductRecommendation[];
}

const SUGGESTED_QUESTIONS = [
  "I want a big change",
  "I'm blonde, need a refresh",
  "Help me choose a color",
  "What's your keratin treatment like?",
  "I have curly hair",
  "Special occasion styling"
];

type ChatContext = 'chat' | 'book' | 'shop';

interface AiChatProps {
  initialMessage?: string;
  onBookService?: () => void;
  onBookSpecificService?: (serviceKey: string, serviceName: string, phorestServiceId?: string) => void;
  onServiceRecommendation?: (recommendations: ServiceRecommendation[]) => void;
  onAddToCart?: (product: ProductRecommendation) => void;
  compact?: boolean;
  context?: ChatContext;
}

function getIntroMessage(context: ChatContext): string {
  switch (context) {
    case 'shop':
      return "Hi there! I'm here to help you find the perfect hair and skincare products. Tell me about your hair type, any concerns you have, or what you're looking for \u2014 and I'll recommend products that are right for you.";
    case 'book':
      return "Hello! I can help you find the perfect salon service. Whether you're looking for a fresh cut, stunning color, relaxing spa treatment, or something special \u2014 just tell me what you have in mind and I'll guide you to the right service.";
    default:
      return "Welcome to Kozeta Salon! I'm your personal stylist assistant. Whether you need help choosing a service, finding the right products for your hair, or have questions about treatments \u2014 I'm here for you. What can I help you with today?";
  }
}

export function AiChat({ initialMessage, onBookService, onBookSpecificService, onServiceRecommendation, onAddToCart, compact = false, context = 'chat' }: AiChatProps) {
  const [messages, setMessages] = useState<ChatMessageWithProducts[]>([
    {
      role: "assistant",
      content: getIntroMessage(context),
      timestamp: Date.now()
    }
  ]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMessageWithProducts[]>(messages);
  const isSendingRef = useRef(false);
  const hasProcessedInitialMessage = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [isStreaming, setIsStreaming] = useState(false);
  const streamingIndexRef = useRef<number | null>(null);

  const startStreamingMessage = () => {
    if (streamingIndexRef.current !== null) return;
    setIsStreaming(true);
    setMessages(prev => {
      streamingIndexRef.current = prev.length;
      return [...prev, { role: "assistant", content: "", timestamp: Date.now() }];
    });
  };

  const appendToStreamingMessage = (text: string) => {
    const idx = streamingIndexRef.current;
    if (idx === null) return;
    setMessages(prev => {
      const next = [...prev];
      if (next[idx]) {
        next[idx] = { ...next[idx], content: (next[idx].content || "") + text };
      }
      return next;
    });
  };

  const finalizeStreamingMessage = (data: any) => {
    const idx = streamingIndexRef.current;
    if (idx === null || !data?.message) return;
    setMessages(prev => {
      const next = [...prev];
      if (next[idx]) {
        next[idx] = {
          ...data.message,
          productRecommendations: data.productRecommendations || []
        };
      }
      return next;
    });

    if (data.message.recommendations && data.message.recommendations.length > 0 && onServiceRecommendation) {
      const recommendations = data.message.recommendations.map((r: any) => ({
        serviceKey: r.serviceKey,
        serviceName: r.serviceName,
        phorestServiceId: r.phorestServiceId
      }));
      onServiceRecommendation(recommendations);
    }
  };

  const chatMutation = useMutation({
    mutationFn: async ({ userMessage, previousMessages }: { userMessage: string; previousMessages: ChatMessage[] }) => {
      streamingIndexRef.current = null;
      const response = await apiRequest("POST", "/api/chat", {
        messages: previousMessages,
        userMessage
      } as ChatRequest);

      if (!response.body) {
        // Fallback: no stream available, parse as JSON
        const data = await response.json();
        startStreamingMessage();
        finalizeStreamingMessage(data);
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
          startStreamingMessage();
          appendToStreamingMessage(event.text || "");
        } else if (event.type === "done") {
          startStreamingMessage();
          finalizeStreamingMessage(event);
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
      streamingIndexRef.current = null;
    },
    onError: (error: any) => {
      console.error("Chat error:", error);
      const idx = streamingIndexRef.current;
      const errorText = "I apologize, but I'm having trouble connecting right now. Please try again.";
      if (idx !== null) {
        setMessages(prev => {
          const next = [...prev];
          if (next[idx]) next[idx] = { ...next[idx], content: errorText };
          return next;
        });
      } else {
        setMessages(prev => [...prev, {
          role: "assistant",
          content: errorText,
          timestamp: Date.now()
        }]);
      }
    }
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatMutation.isPending]);

  useEffect(() => {
    if (initialMessage && !hasProcessedInitialMessage.current && !chatMutation.isPending) {
      hasProcessedInitialMessage.current = true;
      setTimeout(() => {
        handleSendMessage(initialMessage);
      }, 300);
    }
  }, [initialMessage]);

  const handleSendMessage = (messageText: string) => {
    if (!messageText.trim() || chatMutation.isPending || isSendingRef.current) return;

    isSendingRef.current = true;

    const userMessage: ChatMessage = {
      role: "user",
      content: messageText.trim(),
      timestamp: Date.now()
    };

    const previousMessagesSnapshot = [...messagesRef.current];
    setMessages(prev => [...prev, userMessage]);
    chatMutation.mutate({ userMessage: messageText.trim(), previousMessages: previousMessagesSnapshot });
  };

  const handleSend = () => {
    if (!input.trim() || chatMutation.isPending || isSendingRef.current) return;

    handleSendMessage(input.trim());
    setInput("");
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleSuggestedQuestion = (question: string) => {
    setInput(question);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleBookClick = (serviceKey?: string, serviceName?: string, bookingUrl?: string, phorestServiceId?: string) => {
    if (onBookSpecificService && serviceKey && serviceName) {
      onBookSpecificService(serviceKey, serviceName, phorestServiceId);
    } else if (onBookService) {
      onBookService();
    } else if (bookingUrl) {
      window.open(bookingUrl, '_blank');
    }
  };

  return (
    <div className={`flex flex-col space-y-3 ${compact ? 'p-3' : 'p-4'}`}>
      {/* Chat Window */}
      <div 
        data-testid="chat-window"
        className="overflow-y-auto space-y-3 pr-1 rounded-xl"
        style={{ maxHeight: compact ? '180px' : '300px', minHeight: compact ? '120px' : '200px' }}
        ref={scrollRef}
      >
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            data-testid={`message-${message.role}-${index}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border'
              }`}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>

              {/* Service Recommendations */}
              {message.recommendations && message.recommendations.length > 0 && (
                <div className="mt-4 space-y-3 pt-4 border-t border-current/10">
                  <p className="text-xs font-semibold opacity-90">I found some perfect options for you:</p>
                  {message.recommendations.map((rec, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl p-3 bg-card/80 border space-y-3"
                      data-testid={`recommendation-${idx}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <h4 className="font-semibold text-sm text-card-foreground">{rec.serviceName}</h4>
                          <p className="text-xs text-muted-foreground mt-1">
                            {rec.duration} - {rec.price}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-card-foreground/80 leading-relaxed">{rec.description}</p>
                      <Button
                        size="sm"
                        onClick={() => handleBookClick(rec.serviceKey, rec.serviceName, rec.bookingUrl, rec.phorestServiceId)}
                        className="w-full"
                        data-testid={`button-book-recommendation-${idx}`}
                      >
                        <Calendar className="w-4 h-4 mr-2" />
                        Book Now
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              
              {/* Product Recommendations */}
              {message.productRecommendations && message.productRecommendations.length > 0 && (
                <div className="mt-4 space-y-3 pt-4 border-t border-current/10">
                  <p className="text-xs font-semibold opacity-90">Recommended products for you:</p>
                  {message.productRecommendations.map((product, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl p-3 bg-card/80 border space-y-2"
                      data-testid={`product-recommendation-${idx}`}
                    >
                      <div className="flex items-start gap-3">
                        <img 
                          src={product.imageUrl} 
                          alt={product.name}
                          className="w-16 h-16 object-cover rounded-lg border"
                          data-testid={`img-product-${idx}`}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = '/kozeta-product-logo.svg';
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-sm text-card-foreground truncate" data-testid={`text-product-name-${idx}`}>{product.name}</h4>
                          <p className="text-xs text-muted-foreground" data-testid={`text-product-brand-${idx}`}>{product.brandName}</p>
                          <p className="text-sm font-medium text-primary mt-1" data-testid={`text-product-price-${idx}`}>
                            {product.price > 0 ? `$${product.price.toFixed(2)}` : 'Contact for price'}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-card-foreground/80 leading-relaxed line-clamp-2" data-testid={`text-product-description-${idx}`}>{product.description}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAddToCart?.(product)}
                        className="w-full"
                        disabled={!product.inStock}
                        data-testid={`button-add-product-${idx}`}
                      >
                        <ShoppingCart className="w-4 h-4 mr-2" />
                        {product.inStock ? 'Add to Cart' : 'Out of Stock'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {chatMutation.isPending && !isStreaming && (
          <div className="flex justify-start">
            <div className="bg-card border rounded-2xl px-4 py-3 shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
      </div>

      {/* Quick Suggestions */}
      {messages.length === 1 && !initialMessage && (
        <div className="flex flex-wrap gap-1.5">
          {(compact ? SUGGESTED_QUESTIONS.slice(0, 4) : SUGGESTED_QUESTIONS).map((question, index) => (
            <button
              key={index}
              data-testid={`suggested-question-${index}`}
              onClick={() => handleSuggestedQuestion(question)}
              className={`rounded-full border bg-card hover-elevate active-elevate-2 transition-all text-muted-foreground ${
                compact ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'
              }`}
            >
              {question}
            </button>
          ))}
        </div>
      )}

      {/* Input Area */}
      <div className="flex gap-2 items-end">
        <Textarea
          ref={textareaRef}
          data-testid="input-chat-message"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, compact ? 60 : 100) + 'px';
          }}
          onKeyDown={handleKeyDown}
          placeholder={compact ? "Ask about services..." : "Ask me anything about our services..."}
          className={`resize-none rounded-xl text-sm ${compact ? 'min-h-[38px] max-h-[60px]' : 'min-h-[44px] max-h-[100px]'}`}
          rows={1}
          disabled={chatMutation.isPending}
        />
        <Button
          data-testid="button-send-message"
          onClick={handleSend}
          disabled={!input.trim() || chatMutation.isPending}
          size={compact ? "sm" : "default"}
          className={`rounded-xl p-0 flex-shrink-0 ${compact ? 'h-[38px] w-[38px]' : 'h-[44px] w-[44px]'}`}
        >
          {chatMutation.isPending ? (
            <Loader2 className={compact ? "w-3.5 h-3.5 animate-spin" : "w-4 h-4 animate-spin"} />
          ) : (
            <Send className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />
          )}
        </Button>
      </div>
    </div>
  );
}
