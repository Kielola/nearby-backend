import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export const myAiChatSchema = z.object({
  prompt: z.string().max(2000).optional(),
  image: z.string().max(8_000_000).optional(),
  chatHistory: z.unknown().optional(),
});
export type MyAiChatDto = z.infer<typeof myAiChatSchema>;

export const icebreakerSchema = z.object({
  userProfile: z
    .object({
      name: z.string().max(80).optional(),
      interests: z.array(z.string().max(60)).max(30).optional(),
      streetName: z.string().max(160).optional(),
    })
    .optional(),
  neighborProfile: z
    .object({
      name: z.string().max(80).optional(),
      interests: z.array(z.string().max(60)).max(30).optional(),
      streetName: z.string().max(160).optional(),
    })
    .optional(),
});
export type IcebreakerDto = z.infer<typeof icebreakerSchema>;

/**
 * AI helpers, ported from the standalone Express server that used to live in
 * the frontend repo (server.ts).
 *
 * WHY THEY MOVED HERE
 * -------------------
 * Those two routes were the only reason a second Node process had to be
 * deployed alongside the API. Every deployment option that looks at a repo
 * and runs "one web service" — Render, Railway, Zeabur, a $5 VPS — charges
 * you per service, and a free tier with a 750-hour month cannot afford two
 * always-on processes.
 *
 * Moving them in here means the whole backend is ONE service, the API key
 * stays server-side, and the routes inherit Firebase auth + rate limiting
 * for free. server.ts previously had neither: anyone who found the URL could
 * burn your Gemini quota.
 *
 * With no GEMINI_API_KEY configured the endpoints still answer, using the
 * same local fallbacks as before, so the UI is fully clickable in testing.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: GoogleGenAI | null = null;
  private clientInitialised = false;

  constructor(private readonly config: ConfigService) {}

  private getClient(): GoogleGenAI | null {
    if (this.clientInitialised) return this.client;
    this.clientInitialised = true;

    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      this.logger.warn(
        'GEMINI_API_KEY is not set — AI features will use local fallback replies.',
      );
      return null;
    }

    this.client = new GoogleGenAI({ apiKey });
    return this.client;
  }

  private get model(): string {
    // Configurable so a model rename never requires a code change.
    return this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.0-flash';
  }

  async myAiChat(body: MyAiChatDto): Promise<{ response: string }> {
    const client = this.getClient();

    if (!client) {
      return { response: this.simulatedMyAiReply(body.prompt, Boolean(body.image)) };
    }

    const parts: Array<Record<string, unknown>> = [];

    if (body.image) {
      let mimeType = 'image/jpeg';
      let base64Data = body.image;
      if (body.image.startsWith('data:')) {
        const match = body.image.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64Data = match[2];
        }
      }
      parts.push({ inlineData: { mimeType, data: base64Data } });
    }

    parts.push({ text: body.prompt || 'Hey! Comment on my snap!' });

    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents: parts,
        config: {
          systemInstruction:
            "You are 'Nearby AI', a friendly and street-smart virtual guide and companion for Nigerians (especially in Lagos and Abuja!). Speak in an approachable, supportive, and cool young adult tone. Use popular Nigerian English / pidgin words naturally but clearly (e.g. 'How far', 'No wahala', 'Abeg', 'Sharp', 'Vibe', 'Gist'). Suggest cool neighborhood spots like Yaba Tech-Grid, Lekki Admiralty, Ikeja Isaac John, and Wuse II. Use emojis like ✨, 🇳🇬, 🍛, 👻, 🔥, 📸. Keep replies very brief (1-3 sentences max).",
          temperature: 0.9,
        },
      });

      return { response: response.text || "Love that! Keep 'em coming! 👻✨" };
    } catch (error) {
      this.logger.error('Gemini my-ai call failed, using fallback', error as Error);
      return { response: this.simulatedMyAiReply(body.prompt, Boolean(body.image)) };
    }
  }

  async icebreakers(body: IcebreakerDto): Promise<{ starters: string[] }> {
    const interests1 = body.userProfile?.interests ?? [];
    const interests2 = body.neighborProfile?.interests ?? [];
    const neighbourName = body.neighborProfile?.name || 'neighbor';
    const neighbourStreet = body.neighborProfile?.streetName || 'the neighborhood';

    const mutualInterests = interests1.filter((v) =>
      interests2.map((i) => i.toLowerCase()).includes(v.toLowerCase()),
    );

    const client = this.getClient();
    if (!client) {
      return {
        starters: this.localIcebreakers(
          interests2,
          neighbourName,
          neighbourStreet,
          mutualInterests,
        ),
      };
    }

    const promptText = `Generate exactly 3 extremely creative, highly localized, friendly conversation starters/icebreakers in young adult Nigerian pidgin or colloquial English style.
User 1 (Me) Profile: Name: ${body.userProfile?.name || 'User'}, Interests: ${interests1.join(', ') || 'No listed interests'}, Location: ${body.userProfile?.streetName || 'Adjacent block'}.
User 2 (Neighbor) Profile: Name: ${neighbourName}, Interests: ${interests2.join(', ') || 'Discoverable'}, Location: ${neighbourStreet}.
Our shared mutual interests: ${mutualInterests.join(', ') || 'None yet, but they are physical neighbors'}.

Formatting constraints: Return them as a JSON array of strings ONLY. No markdown, no other words. Example output: ["starter 1", "starter 2", "starter 3"]`;

    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents: [{ text: promptText }],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.85,
        },
      });

      let starters: string[] = [];
      try {
        const parsed = JSON.parse(response.text || '[]');
        if (Array.isArray(parsed)) starters = parsed.filter((s) => typeof s === 'string');
      } catch {
        this.logger.warn('Could not parse icebreaker JSON; using local fallback');
      }

      if (starters.length === 0) {
        return {
          starters: this.localIcebreakers(
            interests2,
            neighbourName,
            neighbourStreet,
            mutualInterests,
          ),
        };
      }
      return { starters };
    } catch (error) {
      this.logger.error('Gemini icebreaker call failed, using fallback', error as Error);
      return {
        starters: this.localIcebreakers(
          interests2,
          neighbourName,
          neighbourStreet,
          mutualInterests,
        ),
      };
    }
  }

  // ---- Local fallbacks (identical behaviour to the old Express server) ----

  private simulatedMyAiReply(prompt?: string, hasImage = false): string {
    if (hasImage) {
      return "Whoa, that's a sharp snap! 📸✨ I love your custom filters! Let's make some more designs together in Yaba/Lekki. (PS: Add a real Gemini API Key to unlock full AI vision and chat!)";
    }
    const text = (prompt || '').toLowerCase();
    if (text.includes('hello') || text.includes('hi') || text.includes('how far')) {
      return 'How far my neighbor! 🇳🇬 How are you doing today? Hope no wahala? Ready to connect with neighbors around you? ✨';
    }
    if (text.includes('map') || text.includes('where') || text.includes('radar')) {
      return "I'm currently hanging around the Yaba Tech-Grid! 🇳🇬 Near the delicious Jollof canteen. Check our Nearby Radar to see specifically where people are!";
    }
    if (text.includes('suya') || text.includes('spot') || text.includes('food')) {
      return 'Ah, if you want the best hot spicy Suya in Yaba, check out the joints by Tejuosho or Herbert Macaulay way! They grill the perfect spot-on meat 🥩🔥';
    }
    return "That's super cool, pure vibes! 👻 Tell me more, or send a snap using the Camera!";
  }

  private localIcebreakers(
    neighbourInterests: string[],
    neighbourName: string,
    neighbourStreet: string,
    mutualInterests: string[],
  ): string[] {
    const starters: string[] = [
      `How far ${neighbourName}! 🇳🇬 I noticed we both reside around ${neighbourStreet}. Hope no wahala?`,
    ];

    if (mutualInterests.length > 0) {
      starters.push(`Ah! I noticed we both share a love for ${mutualInterests[0]}! 🍛 How did you get into that?`);
    } else if (neighbourInterests.length > 0) {
      starters.push(`I noticed you're interested in ${neighbourInterests[0]}! Let's connect and discuss it! ✨`);
    }

    const joined = neighbourInterests.join(' ').toLowerCase();
    if (joined.includes('hik')) {
      starters.push("You enjoy hiking? Me too! What's your favorite trail around here? 🌲");
    } else if (joined.includes('farm') || joined.includes('agri')) {
      starters.push("I noticed you're interested in agriculture. Let's chat on local agro-practices! 🌾");
    } else {
      starters.push('We also share mutual proximity! Have you been to the local physical neighborhood events recently? 🎪');
    }

    return starters.slice(0, 3);
  }
}
