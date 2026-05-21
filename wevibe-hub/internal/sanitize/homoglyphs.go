package sanitize

var homoglyphMap = map[rune]rune{
	'а': 'a',
	'е': 'e',
	'о': 'o',
	'р': 'p',
	'с': 'c',
	'у': 'y',
	'х': 'x',
	'ο': 'o',
	'α': 'a',
	'ν': 'v',
	'ι': 'i',
	'τ': 't',
	'κ': 'k',
	'Β': 'B',
	'Ε': 'E',
	'Ο': 'O',
	'Ρ': 'P',
	'Α': 'A',
	'Η': 'H',
	'Χ': 'X',
	'Υ': 'Y',
	'ω': 'w',
	'ϲ': 'c',
	'ѕ': 's',
	'ԁ': 'd',
	'ɡ': 'g',
	'һ': 'h',
	'ⅰ': 'i',
}

var homoglyphCategories = map[rune]string{
	'а': "Cyrillic",
	'е': "Cyrillic",
	'о': "Cyrillic",
	'р': "Cyrillic",
	'с': "Cyrillic",
	'у': "Cyrillic",
	'х': "Cyrillic",
	'ο': "Greek",
	'α': "Greek",
	'ν': "Greek",
	'ι': "Greek",
	'τ': "Greek",
	'κ': "Greek",
	'Β': "Greek",
	'Ε': "Greek",
	'Ο': "Greek",
	'Ρ': "Greek",
	'Α': "Greek",
	'Η': "Greek",
	'Χ': "Greek",
	'Υ': "Greek",
	'ω': "Greek",
	'ϲ': "Coptic",
	'ѕ': "Cyrillic",
	'ԁ': "Cyrillic",
	'ɡ': "Latin",
	'һ': "Cyrillic",
	'ⅰ': "Roman Numeral",
}

type scriptType int

const (
	scriptUnknown scriptType = iota
	scriptLatin
	scriptCyrillic
	scriptGreek
	scriptArabic
	scriptCJK
	scriptOther
)

func detectScript(r rune) scriptType {
	if r >= 0x0041 && r <= 0x007A {
		return scriptLatin
	}
	if r >= 0x0430 && r <= 0x044F {
		return scriptCyrillic
	}
	if r >= 0x0370 && r <= 0x03FF {
		return scriptGreek
	}
	if r >= 0x0600 && r <= 0x06FF {
		return scriptArabic
	}
	if r >= 0x3040 && r <= 0x30FF {
		return scriptCJK
	}
	if r >= 0x4E00 && r <= 0x9FFF {
		return scriptCJK
	}
	if r >= 0xAC00 && r <= 0xD7AF {
		return scriptCJK
	}
	return scriptOther
}

func detectHomoglyphs(text string) []Finding {
	var findings []Finding

	bytes := []byte(text)

	scriptRuns := make([]scriptType, 0, len(bytes))
	for i := 0; i < len(bytes); {
		r, size := utf8Decode(bytes[i:])
		scriptRuns = append(scriptRuns, detectScript(r))
		i += size
	}

	for i := 0; i < len(bytes); {
		r, size := utf8Decode(bytes[i:])
		pos := i

		if replacement, ok := homoglyphMap[r]; ok {
			domScript := dominantScript(scriptRuns, i, size)

			if domScript == scriptLatin {
				category := homoglyphCategories[r]
				findings = append(findings, Finding{
					Category:    "homoglyph",
					Description: category + " homoglyph detected (looks like '" + string(replacement) + "')",
					Position:    pos,
					Codepoint:   codepointStr(r),
					Severity:    "warning",
				})
			}
		}

		i += size
	}

	return findings
}

func dominantScript(scriptRuns []scriptType, charIndex, charSize int) scriptType {
	windowSize := 5
	start := charIndex - windowSize
	if start < 0 {
		start = 0
	}
	end := charIndex + charSize + windowSize
	if end > len(scriptRuns) {
		end = len(scriptRuns)
	}

	scriptCount := make(map[scriptType]int)
	for i := start; i < end; i++ {
		scriptCount[scriptRuns[i]]++
	}

	maxCount := 0
	dominant := scriptUnknown
	for script, count := range scriptCount {
		if count > maxCount {
			maxCount = count
			dominant = script
		}
	}

	if dominant == scriptCyrillic || dominant == scriptGreek || dominant == scriptArabic || dominant == scriptCJK {
		return dominant
	}

	return dominant
}
