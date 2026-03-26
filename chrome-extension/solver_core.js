(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.BinanceWotdSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESULT_ABSENT = '0';
  const RESULT_PRESENT = '1';
  const RESULT_CORRECT = '2';
  const VALID_RESULTS = new Set([RESULT_ABSENT, RESULT_PRESENT, RESULT_CORRECT]);
  const LETTER_ONLY_RE = /^[a-z]+$/;

  function normalizeWord(word) {
    return String(word || '').trim().toLowerCase();
  }

  function normalizePattern(pattern, wordLength) {
    const raw = String(pattern || '').trim();
    let normalized = '';

    for (const char of raw) {
      if (char === ' ' || char === '\t') {
        continue;
      }
      if (char === '0' || char === '1' || char === '2') {
        normalized += char;
        continue;
      }

      const lower = char.toLowerCase();
      if (lower === 'b' || lower === 'x' || lower === 'a' || char === '⬛' || char === '⬜' || char === '⚫') {
        normalized += RESULT_ABSENT;
        continue;
      }
      if (lower === 'y' || char === '🟨') {
        normalized += RESULT_PRESENT;
        continue;
      }
      if (lower === 'g' || lower === 'c' || char === '🟩') {
        normalized += RESULT_CORRECT;
        continue;
      }

      throw new Error(`Unsupported pattern symbol: ${char}`);
    }

    if (normalized.length !== wordLength) {
      throw new Error(`Pattern length must equal ${wordLength}`);
    }

    return normalized;
  }

  function createEmptyCounts() {
    return Object.create(null);
  }

  function countLetters(word) {
    const counts = createEmptyCounts();
    for (const letter of word) {
      counts[letter] = (counts[letter] || 0) + 1;
    }
    return counts;
  }

  function normalizeGuessRows(rows, wordLength) {
    if (!Array.isArray(rows)) {
      throw new Error('rows must be an array');
    }

    const normalizedRows = [];
    for (const [index, row] of rows.entries()) {
      const word = normalizeWord(row && row.word);
      const pattern = String((row && row.pattern) || '').trim();

      if (!word && !pattern) {
        continue;
      }
      if (word.length !== wordLength) {
        throw new Error(`Row ${index + 1}: word length must equal ${wordLength}`);
      }
      if (!LETTER_ONLY_RE.test(word)) {
        throw new Error(`Row ${index + 1}: word must contain letters only`);
      }

      const normalizedPattern = normalizePattern(pattern, wordLength);
      normalizedRows.push({ word, pattern: normalizedPattern });
    }

    return normalizedRows;
  }

  function deriveConstraints(rows, wordLength) {
    const fixed = Array.from({ length: wordLength }, function () {
      return null;
    });
    const bannedAt = Array.from({ length: wordLength }, function () {
      return new Set();
    });
    const minCounts = createEmptyCounts();
    const maxCounts = createEmptyCounts();
    const excludedWords = new Set();

    for (const row of rows) {
      excludedWords.add(row.word);
      const perLetter = createEmptyCounts();

      for (let index = 0; index < wordLength; index += 1) {
        const letter = row.word[index];
        const result = row.pattern[index];

        if (!VALID_RESULTS.has(result)) {
          throw new Error(`Unsupported result value: ${result}`);
        }

        if (!perLetter[letter]) {
          perLetter[letter] = { present: 0, absent: 0 };
        }

        if (result === RESULT_CORRECT) {
          if (fixed[index] && fixed[index] !== letter) {
            throw new Error(`Conflicting fixed letter at position ${index + 1}`);
          }
          fixed[index] = letter;
          perLetter[letter].present += 1;
          continue;
        }

        bannedAt[index].add(letter);

        if (result === RESULT_PRESENT) {
          perLetter[letter].present += 1;
        } else {
          perLetter[letter].absent += 1;
        }
      }

      for (const letter of Object.keys(perLetter)) {
        const info = perLetter[letter];
        if (info.present > 0) {
          minCounts[letter] = Math.max(minCounts[letter] || 0, info.present);
        }
        if (info.absent > 0) {
          const candidateMax = info.present;
          if (typeof maxCounts[letter] === 'number') {
            maxCounts[letter] = Math.min(maxCounts[letter], candidateMax);
          } else {
            maxCounts[letter] = candidateMax;
          }
        }
      }
    }

    for (let index = 0; index < fixed.length; index += 1) {
      const fixedLetter = fixed[index];
      if (fixedLetter && bannedAt[index].has(fixedLetter)) {
        throw new Error(`Position ${index + 1} has conflicting clues for letter "${fixedLetter}"`);
      }
    }

    for (const letter of Object.keys(minCounts)) {
      if (typeof maxCounts[letter] === 'number' && minCounts[letter] > maxCounts[letter]) {
        throw new Error(`Letter "${letter}" has conflicting min/max count clues`);
      }
    }

    return {
      fixed,
      bannedAt,
      minCounts,
      maxCounts,
      excludedWords,
    };
  }

  function candidateMatches(word, constraints, wordLength) {
    if (word.length !== wordLength) {
      return false;
    }
    if (!LETTER_ONLY_RE.test(word)) {
      return false;
    }
    if (constraints.excludedWords.has(word)) {
      return false;
    }

    for (let index = 0; index < wordLength; index += 1) {
      if (constraints.fixed[index] && word[index] !== constraints.fixed[index]) {
        return false;
      }
      if (constraints.bannedAt[index].has(word[index])) {
        return false;
      }
    }

    const counts = countLetters(word);
    for (const letter of Object.keys(constraints.minCounts)) {
      if ((counts[letter] || 0) < constraints.minCounts[letter]) {
        return false;
      }
    }
    for (const letter of Object.keys(constraints.maxCounts)) {
      if ((counts[letter] || 0) > constraints.maxCounts[letter]) {
        return false;
      }
    }

    return true;
  }

  function sortCandidates(candidates) {
    const letterFrequency = createEmptyCounts();

    for (const word of candidates) {
      for (const letter of word) {
        letterFrequency[letter] = (letterFrequency[letter] || 0) + 1;
      }
    }

    function uniqueLetterCount(word) {
      return new Set(word).size;
    }

    function candidateScore(word) {
      let score = 0;
      for (const letter of word) {
        score += letterFrequency[letter] || 0;
      }
      return score;
    }

    return candidates.slice().sort(function (left, right) {
      const uniqueDiff = uniqueLetterCount(right) - uniqueLetterCount(left);
      if (uniqueDiff !== 0) {
        return uniqueDiff;
      }

      const scoreDiff = candidateScore(right) - candidateScore(left);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return left.localeCompare(right);
    });
  }

  function summarizeConstraints(constraints) {
    const fixed = constraints.fixed.map(function (letter) {
      return letter || '·';
    }).join('');

    const minCounts = Object.keys(constraints.minCounts)
      .sort()
      .map(function (letter) {
        return letter + '×' + constraints.minCounts[letter];
      });

    const maxCounts = Object.keys(constraints.maxCounts)
      .sort()
      .map(function (letter) {
        return letter + '≤' + constraints.maxCounts[letter];
      });

    const banned = constraints.bannedAt
      .map(function (letters, index) {
        if (!letters.size) {
          return null;
        }
        return (index + 1) + ':' + Array.from(letters).sort().join('');
      })
      .filter(Boolean);

    return {
      fixed,
      minCounts,
      maxCounts,
      banned,
      excludedWords: Array.from(constraints.excludedWords).sort(),
    };
  }

  function analyze(rows, words, wordLength) {
    const normalizedRows = normalizeGuessRows(rows, wordLength);
    const constraints = deriveConstraints(normalizedRows, wordLength);
    const matched = [];

    for (const rawWord of words || []) {
      const word = normalizeWord(rawWord);
      if (!candidateMatches(word, constraints, wordLength)) {
        continue;
      }
      matched.push(word);
    }

    const sortedCandidates = sortCandidates(matched);
    return {
      rows: normalizedRows,
      total: sortedCandidates.length,
      candidates: sortedCandidates,
      constraints,
      summary: summarizeConstraints(constraints),
    };
  }

  return {
    analyze,
    countLetters,
    deriveConstraints,
    normalizeGuessRows,
    normalizePattern,
    normalizeWord,
    sortCandidates,
  };
});
