import * as React from "react"

import { api } from "@/lib/api"

// The client portal speaks English and Sinhala. Every string is in `en`;
// `si` must have the same keys (the type checks it).

const en = {
  appTagline: "YouTube videos with Sinhala subtitles",
  nav: {
    videos: "Videos",
    ask: "Ask",
    settings: "Settings",
    account: "Your account",
  },
  common: {
    tryAgain: "Try again",
    cancel: "Cancel",
    back: "Back to your videos",
    signOut: "Sign out",
    loading: "Loading…",
    somethingWrong: "Something went wrong.",
  },
  login: {
    welcome: "Welcome to Vidura",
    google: "Continue with Google",
    private:
      "Vidura is private. Only family members the owner invited can sign in.",
    failed: "Couldn’t sign you in",
    errors: {
      not_invited:
        "This Google account hasn’t been invited. Ask the owner to invite your email address.",
      disabled:
        "This account has been disabled. Ask the owner if you think that’s a mistake.",
      unverified_email:
        "Your Google account’s email address isn’t verified yet.",
      account_conflict:
        "A different Google account is already linked to this email address.",
      session_expired:
        "The sign-in took too long or started in another browser. Please try again.",
      cancelled: "Sign-in was cancelled.",
      google_failed: "Google sign-in didn’t finish. Please try again.",
      google_unavailable:
        "Couldn’t reach Google. Please try again in a moment.",
      google_not_configured: "Google sign-in isn’t set up on this server yet.",
      server_error: "Something went wrong on the server. Please try again.",
    } as Record<string, string>,
  },
  offline: {
    title: "Can’t reach Vidura",
    body: "Check your connection and try again.",
  },
  library: {
    title: "Your videos",
    subtitle: "Add a YouTube video and watch it with Sinhala subtitles.",
    search: "Search your videos",
    all: "All",
    ready: "Ready",
    processing: "Processing",
    failed: "Failed",
    emptyTitle: "No videos yet",
    emptyBody:
      "Paste a YouTube link above. Vidura gets the captions, translates them to Sinhala, and lets you watch with subtitles.",
    noMatchTitle: "Nothing matches",
    noMatchBody: "Try another search, or show all videos.",
    showAll: "Show all videos",
    loadFailed: "Couldn’t load your videos",
    previous: "Previous",
    next: "Next",
    pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
    count: (n: number) => (n === 1 ? "1 video" : `${n} videos`),
    loadingMore: "Loading more videos…",
    allLoaded: (n: number) =>
      n === 1 ? "That’s your 1 video." : `That’s all ${n} videos.`,
  },
  add: {
    placeholder: "Paste a YouTube link",
    label: "YouTube link",
    paste: "Paste",
    add: "Add video",
    addShort: "Add",
    already: "That video is already in your library.",
    clipboard: "Couldn’t read the clipboard. Paste the link into the box.",
  },
  status: {
    waiting: "Waiting",
    ready: "Ready",
    failed: "Failed",
    stages: {
      queued: "Waiting to start",
      fetching_transcript: "Getting captions",
      transcribing: "Transcribing the audio",
      translating: "Translating to Sinhala",
    } as Record<string, string>,
    working: "Working on it",
    progress: "Progress",
  },
  watch: {
    notInLibrary: "This video isn’t in your library",
    maybeDeleted: "It may have been deleted.",
    loadFailed: "Couldn’t load it",
    processingBody:
      "Vidura is getting the captions and translating them. Most videos take a few minutes; you can leave this page and come back.",
    failedTitle: "Subtitles couldn’t be made",
    untranslatedTitle: "Some lines aren’t translated",
    untranslatedBody:
      "They show in English. Choose “Translate again” from the menu to fill them in.",
    retrying: "Trying again.",
    wide: "Wide player",
    sideBySide: "Side by side",
  },
  transcript: {
    title: "Transcript",
    sinhala: "සිංහල",
    both: "Both",
    english: "English",
    notTranslated: "Not translated yet",
    follow: "Back to the current line",
  },
  player: {
    play: "Play",
    pause: "Pause",
    mute: "Mute",
    unmute: "Unmute",
    subtitles: "Subtitles",
    settings: "Subtitle settings",
    fullscreen: "Full screen",
    exitFullscreen: "Exit full screen",
    speed: "Speed",
    seek: "Seek",
    volume: "Volume",
    blockedTitle: "This video can’t play here",
    blockedBody:
      "The owner only allows it on YouTube. The transcript below still works alongside it.",
    openYouTube: "Open on YouTube",
    settingsHint: "Saved on this device for every video.",
  },
  captions: {
    show: "Show subtitles",
    language: "Language",
    sinhala: "සිංහල",
    both: "Both",
    english: "English",
    placement: "Where",
    below: "Below the video",
    overlay: "On the video",
    position: "Height on the video",
    font: "Font",
    size: "Text size",
    color: "Text colour",
    background: "Background",
    backgroundColor: "Background colour",
    outline: "Outline",
    outlineNone: "None",
    outlineShadow: "Shadow",
    outlineStroke: "Outline",
    preview: "Preview",
    previewSi: "මෙය උපසිරැසි පෙරදසුනකි",
    previewEn: "This is a subtitle preview",
    reset: "Reset to defaults",
  },
  actions: {
    more: "More actions",
    open: "Open",
    openNewTab: "Open in a new tab",
    askAbout: "Ask about this video",
    copyLink: "Copy YouTube link",
    translateAgain: "Translate again",
    translating: "Translating the subtitles again.",
    transcribeAgain: "Transcribe the audio again",
    transcribing: "Transcribing the audio again. This takes a few minutes.",
    share: "Share",
    copied: "YouTube link copied.",
    openYouTube: "Open on YouTube",
    delete: "Delete video",
    deleteTitle: "Delete this video?",
    deleteBody: (title: string) =>
      `“${title}” and its subtitles are removed from your library. You can add it again later.`,
    keep: "Keep it",
    deleteConfirm: "Delete",
    deleted: "Video deleted.",
  },
  settings: {
    title: "Settings",
    language: "Language",
    languageHint:
      "The language Vidura shows its menus, messages and notifications in.",
    subtitles: "Subtitles",
    subtitlesHint: "How subtitles look while you watch. Saved on this device.",
    appearance: "Appearance",
    theme: "Theme",
    light: "Light",
    dark: "Dark",
    system: "Same as device",
    notifications: "Notifications",
    notificationsHint:
      "Get a notification on this device when a video’s subtitles are ready.",
    notificationsOn: "Notify me on this device",
    notificationsBlocked:
      "Notifications are blocked for Vidura in this browser’s settings. Allow them there, then come back.",
    notificationsUnsupported: "This browser can’t show notifications.",
    notificationsIos:
      "On iPhone and iPad, first add Vidura to your Home Screen (Share → Add to Home Screen), then open it from there.",
    sendTest: "Send a test notification",
    testSent: "Test notification sent.",
    install: "Install the app",
    installHint:
      "Add Vidura to your home screen for a full-screen app with notifications.",
    installButton: "Install Vidura",
    installed: "Vidura is installed on this device.",
    installIos: "On iPhone and iPad: tap Share, then “Add to Home Screen”.",
    account: "Account",
    signedInAs: (email: string) => `Signed in with Google as ${email}.`,
  },
  tabs: {
    transcript: "Transcript",
    learn: "Learn",
    ask: "Ask",
    busy: "still being made",
  },
  learn: {
    title: "Learn from this video",
    language: "Study language",
    summary: "Summary",
    flashcards: "Flashcards",
    quiz: "Quiz",
    pictures: "Pictures",
    notReady: "The study tools open once this video’s subtitles are ready.",
    intro: {
      summary:
        "A study guide: the big picture, each part in order, the key takeaways and terms.",
      flashcards: "Cards to test your memory of the video’s main ideas.",
      quiz: "Check what you understood, with an explanation for every answer.",
      pictures: "Pictures that explain an idea from the video.",
    } as Record<string, string>,
    make: {
      summary: "Make the summary",
      flashcards: "Make flashcards",
      quiz: "Make a quiz",
    } as Record<string, string>,
    making: "Making it… this takes about a minute. You can keep watching.",
    failed: "Couldn’t make it",
    remake: "Make again",
    overview: "Overview",
    takeaways: "Key takeaways",
    terms: "Key terms",
    watchFrom: (time: string) => `Watch from ${time}`,
    card: (i: number, n: number) => `Card ${i} of ${n}`,
    flip: "Tap the card to see the answer",
    flipBack: "Tap to see the question",
    previous: "Previous",
    next: "Next",
    shuffle: "Shuffle",
    question: (i: number, n: number) => `Question ${i} of ${n}`,
    check: "Check",
    nextQuestion: "Next question",
    seeScore: "See my score",
    correct: "Correct!",
    wrong: "Not quite.",
    score: (right: number, total: number) =>
      `You got ${right} of ${total} right`,
    scoreGreat: "Excellent work!",
    scoreGood: "Good effort. Review the parts you missed.",
    retry: "Take the quiz again",
    conceptPlaceholder: "What should the picture explain? (optional)",
    draw: "Draw a picture",
    drawing: "Drawing the picture… this takes a minute or two.",
    noPictures: "No pictures yet.",
    deletePicture: "Delete picture",
  },
  chat: {
    placeholder: "Ask anything about this video…",
    placeholderLibrary: "Ask about your videos…",
    send: "Send",
    thinking: "Thinking…",
    introVideo:
      "Ask a question about this video, in Sinhala or English. You can also ask by voice.",
    introLibrary:
      "Ask about anything in your videos, in Sinhala or English. Vidura looks through your library to answer.",
    promptsVideo: [
      "Summarise this video simply",
      "Explain the main idea with an example",
      "What should I remember from this?",
    ],
    promptsLibrary: [
      "What have I learned recently?",
      "Which videos talk about health?",
      "Make me a study plan from my videos",
    ],
    voice: "Ask by voice",
    stop: "Stop and send",
    listening: "Listening… tap stop when you’re done",
    understanding: "Understanding what you said…",
    micBlocked:
      "Vidura can’t use the microphone. Allow it in your browser’s settings, then try again.",
    micUnsupported:
      "This browser can’t record audio. Type your question instead.",
    spoken: "Spoken",
    newChat: "New chat",
    history: "Your chats",
    noChats: "No chats yet.",
    noChatsBody: "Questions you ask here are saved as chats.",
    rename: "Rename",
    renameTitle: "Rename this chat",
    save: "Save",
    delete: "Delete chat",
    deleteTitle: "Delete this chat?",
    deleteBody: "Its messages are deleted for good.",
    askTitle: "Ask Vidura",
    askSubtitle: "Questions about everything in your library.",
    stopAnswer: "Stop answering",
    retry: "Try again",
    stopped: "You stopped this answer.",
    answering: "Wait for the current answer to finish.",
    errors: {
      quota: "The ChatGPT usage limit was reached. Try again later.",
      ai_unavailable:
        "ChatGPT isn’t connected right now. Ask the owner to reconnect it.",
      timeout: "The tutor took too long to answer.",
      restarted: "Vidura restarted while answering.",
      failed: "Vidura couldn’t answer this.",
    },
    attachVideo: "Ask about a video (/)",
    pickerTitle: "Ask about a video",
    pickerGroup: "Your videos",
    pickerSearch: "Search your videos…",
    pickerEmpty: "No ready videos match.",
    pickerLoading: "Searching…",
    removeVideo: "Remove video",
    alsoAbout: "With",
    slashHint: "Type / to ask about one of your videos.",
    jumpToLatest: "Jump to latest",
  },
  notFound: {
    title: "Page not found",
    body: "This page doesn’t exist.",
    home: "Go to your videos",
  },
  error: {
    title: "Something broke on this page",
  },
  // Notifications, the app icon badge, installing, and adding shared links.
  notify: {
    bell: "Notifications",
    emptyTitle: "Nothing new",
    emptyBody:
      "When subtitles, study notes or an answer you’re waiting for are ready, it shows up here.",
    markAllRead: "Mark all as read",
    unread: (n: number) => `${n} unread`,
    open: "Open",
    updateReady: "A new version of Vidura is ready.",
    reload: "Reload",
    title: "Notifications",
    hint: "Get a notification on this device when subtitles, study notes or a chat answer are ready while Vidura isn’t on your screen.",
    switchLabel: "Notify me on this device",
    onHint:
      "On. While you’re using Vidura, news shows inside the app instead of as a notification.",
    offHint: "Off. You’ll still see news in the bell inside the app.",
    unsupported:
      "This browser can’t show notifications. Try Chrome, Edge, Firefox or Safari.",
    needsInstall:
      "On iPhone and iPad, notifications work once Vidura is on your Home Screen. Add it, open it from there, then turn notifications on here.",
    needsInstallButton: "How to add it",
    blockedTitle: "Notifications are blocked",
    blockedDesktop:
      "Click the icon to the left of the address bar, open Site settings, and set Notifications to Allow. Then come back here.",
    blockedAndroid:
      "Tap ⋮ → Settings → Site settings → Notifications and allow Vidura. In the installed app: long-press its icon → App info → Notifications.",
    blockedIos:
      "Open the Settings app → Notifications → Vidura and turn on Allow Notifications. Then come back here.",
    recheck: "Check again",
    sendTest: "Send a test notification",
    testSent: "Test notification sent. It should appear in a moment.",
    testNone:
      "No device received it. Turn notifications off and on again on this device.",
  },
  install: {
    title: "Install the app",
    hint: "Add Vidura to your home screen: it opens full screen, works offline and can show notifications and an unread badge.",
    button: "Install Vidura",
    menuItem: "Install the app",
    installed: "Vidura is installed on this device.",
    iosTitle: "Add Vidura to your Home Screen",
    iosIntro: "In Safari:",
    iosStep1: "Tap the Share button in the toolbar.",
    iosStep2: "Scroll down and tap “Add to Home Screen”.",
    iosStep3: "Tap Add, then open Vidura from your Home Screen.",
    otherBrowser:
      "Open your browser’s menu and choose “Install app” or “Add to Home screen”.",
    done: "Got it",
  },
  share: {
    title: "Add a video",
    subtitle:
      "Paste a YouTube link. You can also share a video to Vidura from the YouTube app.",
    adding: "Adding the shared video…",
    noLink: "What was shared didn’t include a YouTube link. Paste one below.",
  },
}

export type Messages = typeof en

const si: Messages = {
  appTagline: "සිංහල උපසිරැසි සමඟ YouTube වීඩියෝ",
  nav: {
    videos: "වීඩියෝ",
    ask: "අසන්න",
    settings: "සැකසුම්",
    account: "ඔබේ ගිණුම",
  },
  common: {
    tryAgain: "නැවත උත්සාහ කරන්න",
    cancel: "අවලංගු කරන්න",
    back: "ඔබේ වීඩියෝ වෙත",
    signOut: "ඉවත් වන්න",
    loading: "පූරණය වෙමින්…",
    somethingWrong: "යමක් වැරදුණා.",
  },
  login: {
    welcome: "Vidura වෙත සාදරයෙන් පිළිගනිමු",
    google: "Google සමඟ ඉදිරියට",
    private:
      "Vidura පෞද්ගලිකයි. හිමිකරු ආරාධනා කළ පවුලේ අයට පමණක් ඇතුළු විය හැක.",
    failed: "ඔබව ඇතුළු කළ නොහැකි විය",
    errors: {
      not_invited:
        "මෙම Google ගිණුමට ආරාධනා කර නැත. ඔබේ ඊමේල් ලිපිනයට ආරාධනා කරන ලෙස හිමිකරුගෙන් ඉල්ලන්න.",
      disabled:
        "මෙම ගිණුම අක්‍රිය කර ඇත. එය වැරැද්දක් යැයි සිතන්නේ නම් හිමිකරුගෙන් විමසන්න.",
      unverified_email: "ඔබේ Google ගිණුමේ ඊමේල් ලිපිනය තවම තහවුරු කර නැත.",
      account_conflict:
        "මෙම ඊමේල් ලිපිනයට වෙනත් Google ගිණුමක් දැනටමත් සම්බන්ධ කර ඇත.",
      session_expired:
        "ඇතුළු වීමට වැඩි කාලයක් ගත විය, නැතහොත් වෙනත් බ්‍රව්සරයක ආරම්භ විය. නැවත උත්සාහ කරන්න.",
      cancelled: "ඇතුළු වීම අවලංගු කරන ලදී.",
      google_failed: "Google ඇතුළු වීම සම්පූර්ණ නොවීය. නැවත උත්සාහ කරන්න.",
      google_unavailable:
        "Google වෙත සම්බන්ධ විය නොහැකි විය. මොහොතකින් නැවත උත්සාහ කරන්න.",
      google_not_configured: "මෙම සේවාදායකයේ Google ඇතුළු වීම තවම සකසා නැත.",
      server_error: "සේවාදායකයේ යමක් වැරදුණා. නැවත උත්සාහ කරන්න.",
    },
  },
  offline: {
    title: "Vidura වෙත සම්බන්ධ විය නොහැක",
    body: "ඔබේ සම්බන්ධතාවය පරීක්ෂා කර නැවත උත්සාහ කරන්න.",
  },
  library: {
    title: "ඔබේ වීඩියෝ",
    subtitle: "YouTube වීඩියෝවක් එක් කර සිංහල උපසිරැසි සමඟ නරඹන්න.",
    search: "ඔබේ වීඩියෝ සොයන්න",
    all: "සියල්ල",
    ready: "සූදානම්",
    processing: "සකසමින්",
    failed: "අසාර්ථකයි",
    emptyTitle: "තවම වීඩියෝ නැත",
    emptyBody:
      "ඉහතින් YouTube සබැඳියක් අලවන්න. Vidura උපසිරැසි ලබාගෙන, සිංහලට පරිවර්තනය කර, උපසිරැසි සමඟ නැරඹීමට ඉඩ දෙයි.",
    noMatchTitle: "ගැළපෙන කිසිවක් නැත",
    noMatchBody: "වෙනත් සෙවුමක් උත්සාහ කරන්න, නැතහොත් සියලු වීඩියෝ පෙන්වන්න.",
    showAll: "සියලු වීඩියෝ පෙන්වන්න",
    loadFailed: "ඔබේ වීඩියෝ පූරණය කළ නොහැකි විය",
    previous: "පෙර",
    next: "ඊළඟ",
    pageOf: (page, pages) => `පිටුව ${page} / ${pages}`,
    count: (n) => `වීඩියෝ ${n}`,
    loadingMore: "තවත් වීඩියෝ ගෙන එමින්…",
    allLoaded: (n) => `ඔබේ වීඩියෝ ${n} ම මෙන්න.`,
  },
  add: {
    placeholder: "YouTube සබැඳියක් අලවන්න",
    label: "YouTube සබැඳිය",
    paste: "අලවන්න",
    add: "වීඩියෝව එක් කරන්න",
    addShort: "එක් කරන්න",
    already: "එම වීඩියෝව දැනටමත් ඔබේ පුස්තකාලයේ ඇත.",
    clipboard: "ක්ලිප්බෝඩය කියවිය නොහැකි විය. සබැඳිය කොටුවට අලවන්න.",
  },
  status: {
    waiting: "රැඳී සිටී",
    ready: "සූදානම්",
    failed: "අසාර්ථකයි",
    stages: {
      queued: "ආරම්භ වීමට රැඳී සිටී",
      fetching_transcript: "උපසිරැසි ලබාගනිමින්",
      transcribing: "ශ්‍රව්‍යය අකුරු කරමින්",
      translating: "සිංහලට පරිවර්තනය කරමින්",
    },
    working: "වැඩ කරමින්",
    progress: "ප්‍රගතිය",
  },
  watch: {
    notInLibrary: "මෙම වීඩියෝව ඔබේ පුස්තකාලයේ නැත",
    maybeDeleted: "එය මකා දමා ඇති විය හැක.",
    loadFailed: "එය පූරණය කළ නොහැකි විය",
    processingBody:
      "Vidura උපසිරැසි ලබාගෙන පරිවර්තනය කරමින් සිටී. බොහෝ වීඩියෝ සඳහා මිනිත්තු කිහිපයක් ගතවේ; ඔබට මෙම පිටුවෙන් ඉවත් වී පසුව නැවත පැමිණිය හැක.",
    failedTitle: "උපසිරැසි සෑදිය නොහැකි විය",
    untranslatedTitle: "සමහර පේළි පරිවර්තනය කර නැත",
    untranslatedBody:
      "ඒවා ඉංග්‍රීසියෙන් පෙන්වයි. ඒවා පුරවන්න මෙනුවෙන් “නැවත පරිවර්තනය කරන්න” තෝරන්න.",
    retrying: "නැවත උත්සාහ කරමින්.",
    wide: "පුළුල් වීඩියෝව",
    sideBySide: "පැත්තෙන් පැත්තට",
  },
  transcript: {
    title: "පිටපත",
    sinhala: "සිංහල",
    both: "දෙකම",
    english: "English",
    notTranslated: "තවම පරිවර්තනය කර නැත",
    follow: "දැන් කියවෙන පේළියට",
  },
  player: {
    play: "ධාවනය",
    pause: "විරාමය",
    mute: "ශබ්දය නිවන්න",
    unmute: "ශබ්දය සක්‍රිය කරන්න",
    subtitles: "උපසිරැසි",
    settings: "උපසිරැසි සැකසුම්",
    fullscreen: "සම්පූර්ණ තිරය",
    exitFullscreen: "සම්පූර්ණ තිරයෙන් ඉවත් වන්න",
    speed: "වේගය",
    seek: "ස්ථානය",
    volume: "ශබ්දය",
    blockedTitle: "මෙම වීඩියෝව මෙහි ධාවනය කළ නොහැක",
    blockedBody:
      "හිමිකරු එයට ඉඩ දෙන්නේ YouTube හි පමණි. පහත පිටපත එය සමඟ තවමත් ක්‍රියා කරයි.",
    openYouTube: "YouTube හි විවෘත කරන්න",
    settingsHint: "සෑම වීඩියෝවක් සඳහාම මෙම උපාංගයේ සුරැකේ.",
  },
  captions: {
    show: "උපසිරැසි පෙන්වන්න",
    language: "භාෂාව",
    sinhala: "සිංහල",
    both: "දෙකම",
    english: "English",
    placement: "ස්ථානය",
    below: "වීඩියෝවට පහළින්",
    overlay: "වීඩියෝව මත",
    position: "වීඩියෝව මත උස",
    font: "අකුරු වර්ගය",
    size: "අකුරු ප්‍රමාණය",
    color: "අකුරු වර්ණය",
    background: "පසුබිම",
    backgroundColor: "පසුබිම් වර්ණය",
    outline: "දාරය",
    outlineNone: "නැත",
    outlineShadow: "සෙවණැල්ල",
    outlineStroke: "දාරය",
    preview: "පෙරදසුන",
    previewSi: "මෙය උපසිරැසි පෙරදසුනකි",
    previewEn: "This is a subtitle preview",
    reset: "පෙරනිමි සැකසුම් වෙත",
  },
  actions: {
    more: "තවත් ක්‍රියා",
    open: "විවෘත කරන්න",
    openNewTab: "නව ටැබයක විවෘත කරන්න",
    askAbout: "මෙම වීඩියෝව ගැන අසන්න",
    copyLink: "YouTube සබැඳිය පිටපත් කරන්න",
    translateAgain: "නැවත පරිවර්තනය කරන්න",
    translating: "උපසිරැසි නැවත පරිවර්තනය කරමින්.",
    transcribeAgain: "ශ්‍රව්‍යය නැවත අකුරු කරන්න",
    transcribing: "ශ්‍රව්‍යය නැවත අකුරු කරමින්. මිනිත්තු කිහිපයක් ගතවේ.",
    share: "බෙදාගන්න",
    copied: "YouTube සබැඳිය පිටපත් කළා.",
    openYouTube: "YouTube හි විවෘත කරන්න",
    delete: "වීඩියෝව මකන්න",
    deleteTitle: "මෙම වීඩියෝව මකන්නද?",
    deleteBody: (title) =>
      `“${title}” සහ එහි උපසිරැසි ඔබේ පුස්තකාලයෙන් ඉවත් කෙරේ. පසුව නැවත එක් කළ හැක.`,
    keep: "තබා ගන්න",
    deleteConfirm: "මකන්න",
    deleted: "වීඩියෝව මකා දැමුවා.",
  },
  settings: {
    title: "සැකසුම්",
    language: "භාෂාව",
    languageHint: "Vidura මෙනු, පණිවිඩ සහ දැනුම්දීම් පෙන්වන භාෂාව.",
    subtitles: "උපසිරැසි",
    subtitlesHint: "නරඹන අතරතුර උපසිරැසි පෙනෙන ආකාරය. මෙම උපාංගයේ සුරැකේ.",
    appearance: "පෙනුම",
    theme: "තේමාව",
    light: "ආලෝක",
    dark: "අඳුරු",
    system: "උපාංගයට සමානව",
    notifications: "දැනුම්දීම්",
    notificationsHint:
      "වීඩියෝවක උපසිරැසි සූදානම් වූ විට මෙම උපාංගයට දැනුම්දීමක් ලබාගන්න.",
    notificationsOn: "මෙම උපාංගයට දැනුම් දෙන්න",
    notificationsBlocked:
      "මෙම බ්‍රව්සරයේ සැකසුම්වල Vidura සඳහා දැනුම්දීම් අවහිර කර ඇත. එහිදී ඒවාට ඉඩ දී නැවත පැමිණෙන්න.",
    notificationsUnsupported: "මෙම බ්‍රව්සරයට දැනුම්දීම් පෙන්විය නොහැක.",
    notificationsIos:
      "iPhone සහ iPad හි, පළමුව Vidura ඔබේ Home Screen වෙත එක් කරන්න (Share → Add to Home Screen), ඉන්පසු එතැනින් විවෘත කරන්න.",
    sendTest: "පරීක්ෂණ දැනුම්දීමක් යවන්න",
    testSent: "පරීක්ෂණ දැනුම්දීම යැව්වා.",
    install: "යෙදුම ස්ථාපනය කරන්න",
    installHint:
      "දැනුම්දීම් සහිත සම්පූර්ණ තිර යෙදුමක් සඳහා Vidura ඔබේ මුල් තිරයට එක් කරන්න.",
    installButton: "Vidura ස්ථාපනය කරන්න",
    installed: "Vidura මෙම උපාංගයේ ස්ථාපනය කර ඇත.",
    installIos:
      "iPhone සහ iPad හි: Share තට්ටු කර “Add to Home Screen” තෝරන්න.",
    account: "ගිණුම",
    signedInAs: (email) => `${email} ලෙස Google සමඟ ඇතුළු වී ඇත.`,
  },
  tabs: {
    transcript: "පිටපත",
    learn: "ඉගෙන ගන්න",
    ask: "අසන්න",
    busy: "තවමත් සාදමින්",
  },
  learn: {
    title: "මෙම වීඩියෝවෙන් ඉගෙන ගන්න",
    language: "ඉගෙනුම් භාෂාව",
    summary: "සාරාංශය",
    flashcards: "මතක කාඩ්",
    quiz: "ප්‍රශ්නාවලිය",
    pictures: "රූප",
    notReady: "මෙම වීඩියෝවේ උපසිරැසි සූදානම් වූ පසු ඉගෙනුම් මෙවලම් විවෘත වේ.",
    intro: {
      summary:
        "අධ්‍යයන මාර්ගෝපදේශයක්: සමස්ත අදහස, එක් එක් කොටස පිළිවෙළින්, ප්‍රධාන කරුණු සහ වචන.",
      flashcards: "වීඩියෝවේ ප්‍රධාන අදහස් ඔබට මතකද කියා පරීක්ෂා කරන කාඩ්.",
      quiz: "ඔබ තේරුම් ගත් දේ පරීක්ෂා කරන්න; සෑම පිළිතුරකටම පැහැදිලි කිරීමක් සමඟ.",
      pictures: "වීඩියෝවේ අදහසක් පැහැදිලි කරන රූප.",
    },
    make: {
      summary: "සාරාංශය සාදන්න",
      flashcards: "මතක කාඩ් සාදන්න",
      quiz: "ප්‍රශ්නාවලියක් සාදන්න",
    },
    making: "සාදමින්… මිනිත්තුවක් පමණ ගතවේ. ඔබට දිගටම නැරඹිය හැක.",
    failed: "සෑදිය නොහැකි විය",
    remake: "නැවත සාදන්න",
    overview: "සමස්ත අදහස",
    takeaways: "ප්‍රධාන කරුණු",
    terms: "වැදගත් වචන",
    watchFrom: (time) => `${time} සිට නරඹන්න`,
    card: (i, n) => `කාඩ් ${i} / ${n}`,
    flip: "පිළිතුර බැලීමට කාඩ් එක තට්ටු කරන්න",
    flipBack: "ප්‍රශ්නය බැලීමට තට්ටු කරන්න",
    previous: "පෙර",
    next: "ඊළඟ",
    shuffle: "මිශ්‍ර කරන්න",
    question: (i, n) => `ප්‍රශ්නය ${i} / ${n}`,
    check: "පරීක්ෂා කරන්න",
    nextQuestion: "ඊළඟ ප්‍රශ්නය",
    seeScore: "මගේ ලකුණු බලන්න",
    correct: "නිවැරදියි!",
    wrong: "එතරම් නිවැරදි නැහැ.",
    score: (right, total) => `ඔබ ${total} න් ${right} ක් නිවැරදි කළා`,
    scoreGreat: "විශිෂ්ටයි!",
    scoreGood: "හොඳ උත්සාහයක්. වැරදුණු කොටස් නැවත බලන්න.",
    retry: "ප්‍රශ්නාවලිය නැවත කරන්න",
    conceptPlaceholder: "රූපයෙන් පැහැදිලි කළ යුත්තේ කුමක්ද? (අත්‍යවශ්‍ය නැත)",
    draw: "රූපයක් අඳින්න",
    drawing: "රූපය අඳිමින්… මිනිත්තුවක් හෝ දෙකක් ගතවේ.",
    noPictures: "තවම රූප නැත.",
    deletePicture: "රූපය මකන්න",
  },
  chat: {
    placeholder: "මෙම වීඩියෝව ගැන ඕනෑම දෙයක් අසන්න…",
    placeholderLibrary: "ඔබේ වීඩියෝ ගැන අසන්න…",
    send: "යවන්න",
    thinking: "සිතමින්…",
    introVideo:
      "මෙම වීඩියෝව ගැන සිංහලෙන් හෝ ඉංග්‍රීසියෙන් ප්‍රශ්නයක් අසන්න. හඬින්ද ඇසිය හැක.",
    introLibrary:
      "ඔබේ වීඩියෝවල ඇති ඕනෑම දෙයක් ගැන සිංහලෙන් හෝ ඉංග්‍රීසියෙන් අසන්න. පිළිතුරු දීමට Vidura ඔබේ පුස්තකාලය පරීක්ෂා කරයි.",
    promptsVideo: [
      "මෙම වීඩියෝව සරලව සාරාංශ කරන්න",
      "ප්‍රධාන අදහස උදාහරණයකින් පැහැදිලි කරන්න",
      "මෙයින් මට මතක තබාගත යුත්තේ කුමක්ද?",
    ],
    promptsLibrary: [
      "මම මෑතකදී ඉගෙන ගත්තේ මොනවාද?",
      "සෞඛ්‍යය ගැන කතා කරන වීඩියෝ මොනවාද?",
      "මගේ වීඩියෝවලින් අධ්‍යයන සැලැස්මක් හදන්න",
    ],
    voice: "හඬින් අසන්න",
    stop: "නවත්වා යවන්න",
    listening: "සවන් දෙමින්… අවසන් වූ විට නවත්වන්න තට්ටු කරන්න",
    understanding: "ඔබ කී දේ තේරුම් ගනිමින්…",
    micBlocked:
      "Vidura ට මයික්‍රෆෝනය භාවිත කළ නොහැක. ඔබේ බ්‍රව්සරයේ සැකසුම්වල එයට ඉඩ දී නැවත උත්සාහ කරන්න.",
    micUnsupported:
      "මෙම බ්‍රව්සරයට ශබ්දය පටිගත කළ නොහැක. ඔබේ ප්‍රශ්නය ටයිප් කරන්න.",
    spoken: "හඬින්",
    newChat: "නව සංවාදය",
    history: "ඔබේ සංවාද",
    noChats: "තවම සංවාද නැත.",
    noChatsBody: "මෙහි ඔබ අසන ප්‍රශ්න සංවාද ලෙස සුරැකේ.",
    rename: "නම වෙනස් කරන්න",
    renameTitle: "මෙම සංවාදයේ නම වෙනස් කරන්න",
    save: "සුරකින්න",
    delete: "සංවාදය මකන්න",
    deleteTitle: "මෙම සංවාදය මකන්නද?",
    deleteBody: "එහි පණිවිඩ සදහටම මැකේ.",
    askTitle: "Vidura ගෙන් අසන්න",
    askSubtitle: "ඔබේ පුස්තකාලයේ ඇති සියල්ල ගැන ප්‍රශ්න.",
    stopAnswer: "පිළිතුර නවත්වන්න",
    retry: "නැවත උත්සාහ කරන්න",
    stopped: "ඔබ මෙම පිළිතුර නැවැත්තුවා.",
    answering: "වත්මන් පිළිතුර අවසන් වන තුරු රැඳී සිටින්න.",
    errors: {
      quota: "ChatGPT භාවිත සීමාව ඉක්මවා ඇත. පසුව නැවත උත්සාහ කරන්න.",
      ai_unavailable:
        "ChatGPT දැනට සම්බන්ධ නැත. එය නැවත සම්බන්ධ කරන ලෙස හිමිකරුගෙන් ඉල්ලන්න.",
      timeout: "පිළිතුරු දීමට වැඩි වේලාවක් ගත විය.",
      restarted: "පිළිතුරු දෙමින් සිටියදී Vidura නැවත ආරම්භ විය.",
      failed: "Vidura හට මෙයට පිළිතුරු දීමට නොහැකි විය.",
    },
    attachVideo: "වීඩියෝවක් ගැන අසන්න (/)",
    pickerTitle: "වීඩියෝවක් ගැන අසන්න",
    pickerGroup: "ඔබේ වීඩියෝ",
    pickerSearch: "ඔබේ වීඩියෝ සොයන්න…",
    pickerEmpty: "ගැළපෙන වීඩියෝ නැත.",
    pickerLoading: "සොයමින්…",
    removeVideo: "වීඩියෝව ඉවත් කරන්න",
    alsoAbout: "සමඟ",
    slashHint: "ඔබේ වීඩියෝවක් ගැන ඇසීමට / ටයිප් කරන්න.",
    jumpToLatest: "නවතම පණිවිඩයට",
  },
  notFound: {
    title: "පිටුව හමු නොවීය",
    body: "මෙම පිටුව නොපවතී.",
    home: "ඔබේ වීඩියෝ වෙත යන්න",
  },
  error: {
    title: "මෙම පිටුවේ යමක් බිඳී ගියා",
  },
  notify: {
    bell: "දැනුම්දීම්",
    emptyTitle: "අලුත් දෙයක් නැත",
    emptyBody:
      "ඔබ බලාපොරොත්තුවෙන් සිටින උපසිරැසි, අධ්‍යයන සටහන් හෝ පිළිතුරක් සූදානම් වූ විට එය මෙහි පෙනේ.",
    markAllRead: "සියල්ල කියවූ ලෙස සලකුණු කරන්න",
    unread: (n: number) => `නොකියවූ ${n}`,
    open: "විවෘත කරන්න",
    updateReady: "Vidura හි නව සංස්කරණයක් සූදානම්.",
    reload: "නැවත පූරණය කරන්න",
    title: "දැනුම්දීම්",
    hint: "Vidura ඔබේ තිරයේ නොමැති විට උපසිරැසි, අධ්‍යයන සටහන් හෝ කතාබහ පිළිතුරක් සූදානම් වූ විට මෙම උපාංගයට දැනුම්දීමක් ලබාගන්න.",
    switchLabel: "මෙම උපාංගයට දැනුම් දෙන්න",
    onHint:
      "සක්‍රියයි. ඔබ Vidura භාවිත කරන අතරතුර, පුවත් දැනුම්දීමක් ලෙස නොව යෙදුම තුළම පෙන්වයි.",
    offHint: "අක්‍රියයි. යෙදුම තුළ ඇති සීනුවෙන් ඔබට තවමත් පුවත් දැකිය හැක.",
    unsupported:
      "මෙම බ්‍රව්සරයට දැනුම්දීම් පෙන්විය නොහැක. Chrome, Edge, Firefox හෝ Safari උත්සාහ කරන්න.",
    needsInstall:
      "iPhone සහ iPad හි, Vidura මුල් තිරයට (Home Screen) එක් කළ පසු දැනුම්දීම් ක්‍රියා කරයි. එය එක් කර, එතැනින් විවෘත කර, ඉන්පසු මෙහි දැනුම්දීම් සක්‍රිය කරන්න.",
    needsInstallButton: "එක් කරන ආකාරය",
    blockedTitle: "දැනුම්දීම් අවහිර කර ඇත",
    blockedDesktop:
      "ලිපින තීරුවේ වම්පස ඇති අයිකනය ක්ලික් කර, Site settings විවෘත කර, Notifications සඳහා Allow තෝරන්න. ඉන්පසු මෙහි නැවත පැමිණෙන්න.",
    blockedAndroid:
      "⋮ → Settings → Site settings → Notifications තට්ටු කර Vidura ට ඉඩ දෙන්න. ස්ථාපිත යෙදුමේ නම්: එහි අයිකනය දිගු වේලාවක් තද කර → App info → Notifications.",
    blockedIos:
      "Settings යෙදුම → Notifications → Vidura විවෘත කර Allow Notifications සක්‍රිය කරන්න. ඉන්පසු මෙහි නැවත පැමිණෙන්න.",
    recheck: "නැවත පරීක්ෂා කරන්න",
    sendTest: "පරීක්ෂණ දැනුම්දීමක් යවන්න",
    testSent: "පරීක්ෂණ දැනුම්දීම යැව්වා. එය මොහොතකින් පෙනෙනු ඇත.",
    testNone:
      "කිසිදු උපාංගයකට එය ලැබුණේ නැත. මෙම උපාංගයේ දැනුම්දීම් අක්‍රිය කර නැවත සක්‍රිය කරන්න.",
  },
  install: {
    title: "යෙදුම ස්ථාපනය කරන්න",
    hint: "Vidura ඔබේ මුල් තිරයට එක් කරන්න: එය සම්පූර්ණ තිරයෙන් විවෘත වේ, අන්තර්ජාලය නැතිවද විවෘත වේ, දැනුම්දීම් සහ නොකියවූ ගණන පෙන්විය හැක.",
    button: "Vidura ස්ථාපනය කරන්න",
    menuItem: "යෙදුම ස්ථාපනය කරන්න",
    installed: "Vidura මෙම උපාංගයේ ස්ථාපනය කර ඇත.",
    iosTitle: "Vidura මුල් තිරයට එක් කරන්න",
    iosIntro: "Safari හි:",
    iosStep1: "මෙවලම් තීරුවේ ඇති Share බොත්තම තට්ටු කරන්න.",
    iosStep2: "පහළට අනුචලනය කර “Add to Home Screen” තට්ටු කරන්න.",
    iosStep3: "Add තට්ටු කර, ඉන්පසු මුල් තිරයෙන් Vidura විවෘත කරන්න.",
    otherBrowser:
      "ඔබේ බ්‍රව්සරයේ මෙනුව විවෘත කර “Install app” හෝ “Add to Home screen” තෝරන්න.",
    done: "හරි",
  },
  share: {
    title: "වීඩියෝවක් එක් කරන්න",
    subtitle:
      "YouTube සබැඳියක් අලවන්න. YouTube යෙදුමෙන් Vidura වෙත වීඩියෝවක් බෙදාගැනීමටද හැක.",
    adding: "බෙදාගත් වීඩියෝව එක් කරමින්…",
    noLink: "බෙදාගත් දෙයෙහි YouTube සබැඳියක් නොතිබුණි. පහතින් එකක් අලවන්න.",
  },
}

export type Locale = "en" | "si"
const messages: Record<Locale, Messages> = { en, si }

const KEY = "vidura.locale"

function savedLocale(): Locale {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === "en" || saved === "si") return saved
  } catch {
    // Private browsing.
  }
  return navigator.language.toLowerCase().startsWith("si") ? "si" : "en"
}

type LocaleState = {
  locale: Locale
  t: Messages
  /** Changes the language here, and (when signed in) on the account. */
  setLocale: (locale: Locale, opts?: { save?: boolean }) => void
}

const LocaleContext = React.createContext<LocaleState | null>(null)

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setState] = React.useState<Locale>(savedLocale)

  const setLocale = React.useCallback(
    (next: Locale, opts?: { save?: boolean }) => {
      setState(next)
      try {
        localStorage.setItem(KEY, next)
      } catch {
        // Private browsing.
      }
      if (opts?.save) {
        api.patch("/api/me/preferences", { locale: next }).catch(() => {})
      }
    },
    []
  )

  React.useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = React.useMemo(
    () => ({ locale, t: messages[locale], setLocale }),
    [locale, setLocale]
  )
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  )
}

export function useLocale(): LocaleState {
  const value = React.useContext(LocaleContext)
  if (!value) throw new Error("useLocale outside LocaleProvider")
  return value
}

/** The messages in the current language. */
export function useT(): Messages {
  return useLocale().t
}
