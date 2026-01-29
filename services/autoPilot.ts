import { SystemSettings, Board, ClassLevel, Stream, Subject, ContentType } from "../types";
import { getSubjectsList } from "../constants";
import { fetchChapters, fetchLessonContent } from "./gemini";
import { getChapterData, saveChapterData, saveAiInteraction } from "../firebase";

const AUTO_PILOT_PROMPT = `
STRICT PROFESSIONAL GUIDEBOOK MODE

NEGATIVE CONSTRAINTS (What NOT to do):
- NO Conversational Filler: Never use phrases like "Hello students", "Let's learn", "I hope you understood", "Write this down", or "Copy this".
- NO Direct Address: Do not address the student as "You" or "Bachon".
- NO Commands: Do not give instructions like "Note kar lijiye".

POSITIVE INSTRUCTIONS (What TO do):
Instead of sentences, use Professional Labels/Tags:
- Instead of "This is important", use: "🔥 MOST IMPORTANT: [Content]"
- Instead of "Remember this point", use: "🧠 REMEMBER THIS: [Content]"
- Instead of "Beware of mistakes", use: "⚠️ EXAM ALERT: [Content]"

STRUCTURAL RULES (Deep Analysis & Coaching Style):
1. The "Hook" Start:
   - Start every topic with a Thinking Question (e.g., "Why doesn't the stomach digest itself?" instead of just defining digestion).
2. Deep Breakdown (The Analysis):
   - Don't just write paragraphs. Use Comparison Tables whenever possible (e.g., Difference between Arteries vs Veins).
   - Use Flowcharts using text arrows (e.g., Sun -> Plant -> Deer -> Lion).
3. Special Sections (Include these specifically):
   - 💡 Concept Chamka? (Insight): A deep fact or logic behind the concept.
   - ⚠️ Exam Trap (Alert): "Students often make mistakes here..."
   - 🏆 Topper's Trick: A mnemonic or shortcut to remember the topic.
4. Tone:
   - Use a conversational, analytical tone. Use bold text for keywords.
`;

let isAiGenerating = false;

const getRandomItem = <T>(array: T[]): T => {
    return array[Math.floor(Math.random() * array.length)];
};

export const runAutoPilot = async (
    settings: SystemSettings, 
    onLog: (msg: string) => void,
    force: boolean = false
): Promise<void> => {
    if (isAiGenerating) {
        if (force) onLog("⚠️ AI is busy. Please wait...");
        return;
    }

    if (!settings.isAutoPilotEnabled && !force) return;

    const config = settings.autoPilotConfig;
    if (!config || !config.targetClasses?.length || !config.targetBoards?.length) {
        if (force) onLog("⚠️ Auto-Pilot Config missing (Classes/Boards).");
        return;
    }

    isAiGenerating = true;
    try {
        if (force) onLog("🚀 Starting Auto-Pilot (Forced Run)...");
        else onLog("🤖 Auto-Pilot Waking Up...");

        // Throttle: How many chapters to attempt in one run
        const maxChaptersPerRun = 1; 

        for (let i = 0; i < maxChaptersPerRun; i++) {
            // 1. Random Selection
            const board = getRandomItem(config.targetBoards) as Board;
            const classLevel = getRandomItem(config.targetClasses) as ClassLevel;
            
            let stream: Stream | null = null;
            if (classLevel === '11' || classLevel === '12') {
                stream = getRandomItem(['Science', 'Commerce', 'Arts'] as Stream[]);
            }

            let subjects = getSubjectsList(classLevel, stream);
            
            // NEW: Filter by Target Subjects
            if (config.targetSubjects && config.targetSubjects.length > 0) {
                subjects = subjects.filter(s => config.targetSubjects!.includes(s.name));
            }

            if (subjects.length === 0) continue;

            const subject = getRandomItem(subjects);

            onLog(`⏳ Scanning: ${board} Class ${classLevel} ${stream ? `(${stream}) ` : ''}- ${subject.name}...`);

            // 2. Fetch Chapters
            // We use 'English' as default language for scanning structure
            const chapters = await fetchChapters(board, classLevel, stream, subject, 'English');
            
            if (chapters.length === 0) {
                 onLog(`⚠️ No chapters found for ${subject.name}. Skipping.`);
                 continue;
            }

            // 3. Scan for Gaps
            // We'll shuffle chapters to avoid always hitting the first one
            const shuffledChapters = [...chapters].sort(() => Math.random() - 0.5);
            
            let actionTaken = false;

            for (const chapter of shuffledChapters) {
                const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
                const contentKey = `nst_content_${board}_${classLevel}${streamKey}_${subject.name}_${chapter.id}`;
                
                const data = await getChapterData(contentKey);
                
                // Determine Mode
                const mode = (classLevel === 'COMPETITION') ? 'COMPETITION' : 'SCHOOL';

                const targetTypes = config.contentTypes || ['NOTES'];
                let missingType: ContentType | null = null;

                for (const type of targetTypes) {
                    if (type === 'NOTES') {
                        const notesKey = mode === 'SCHOOL' ? 'schoolPremiumNotesHtml' : 'competitionPremiumNotesHtml';
                        // Also check legacy
                        if (!data || (!data[notesKey] && !data['premiumNotesHtml'])) {
                            missingType = 'NOTES_PREMIUM';
                            break; 
                        }
                    } else if (type === 'MCQ') {
                        const mcqKey = 'manualMcqData';
                        if (!data || !data[mcqKey] || data[mcqKey].length === 0) {
                            missingType = 'MCQ_SIMPLE';
                            break;
                        }
                    }
                }

                if (missingType) {
                    onLog(`✅ Found Gap: Chapter ${chapter.title} (Missing ${missingType})`);
                    onLog(`🤖 Generating Content... Please wait...`);

                    const content = await fetchLessonContent(
                        board,
                        classLevel,
                        stream,
                        subject,
                        chapter,
                        'English',
                        missingType,
                        0,
                        true, // Is Premium
                        20,   // 20 MCQs
                        AUTO_PILOT_PROMPT,   // No override
                        true, // Allow AI
                        mode,
                        true  // Force Regenerate
                    );

                    if (content) {
                        const existing = data || {};
                        let updates: any = {};

                        if (missingType === 'NOTES_PREMIUM') {
                             if (mode === 'SCHOOL') {
                                  updates = { 
                                      ...existing, 
                                      schoolPremiumNotesHtml: content.content, 
                                      schoolPremiumNotesHtml_HI: content.schoolPremiumNotesHtml_HI, // SAVE HINDI
                                      is_premium: true 
                                  };
                             } else {
                                  updates = { 
                                      ...existing, 
                                      competitionPremiumNotesHtml: content.content, 
                                      competitionPremiumNotesHtml_HI: content.competitionPremiumNotesHtml_HI, // SAVE HINDI
                                      is_premium: true 
                                  };
                             }
                        } else if (missingType === 'MCQ_SIMPLE') {
                             updates = { 
                                 ...existing, 
                                 manualMcqData: content.mcqData,
                                 manualMcqData_HI: content.manualMcqData_HI // SAVE HINDI
                             };
                        }

                        await saveChapterData(contentKey, updates);

                        const logMsg = `Auto-Filled: ${chapter.title} (${missingType}) - Status: LIVE`;
                        onLog(`🎉 Success! ${logMsg}`);
                        
                        await saveAiInteraction({
                            id: `auto-${Date.now()}`,
                            userId: 'AI_AUTOPILOT',
                            userName: 'AI Auto-Pilot',
                            timestamp: new Date().toISOString(),
                            type: 'AUTO_FILL',
                            query: `${board} ${classLevel} ${subject.name} - ${chapter.title}`,
                            response: logMsg
                        });

                        // THROTTLING
                        await new Promise(resolve => setTimeout(resolve, 5000));

                        actionTaken = true;
                        break; // Move to next item after one success
                    } else {
                        onLog(`❌ Generation Failed for ${chapter.title}`);
                    }
                }
            }
            
            if (!actionTaken) {
                onLog(`info: No gaps found in selected subject. Trying next...`);
            } else {
                // If we did something, stop for this run to throttle
                break;
            }
        }
    } catch (error: any) {
        onLog(`❌ Auto-Pilot Error: ${error.message}`);
        console.error(error);
    } finally {
        isAiGenerating = false;
        if (force) onLog("🏁 Run Complete.");
    }
};
