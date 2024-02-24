def matchWord(fp):
    matchedList = []
    for word in fp.readlines():
        word = word.strip()
        if not word.isalpha():
            continue
        if len(word) != 4:
            continue
        # Exclude a specific word
        if any(letter in word for letter in ['e', 'a', 'l', 'p', 'o', 't', 'i', 'g']):
            continue

        # Must contain certain letters
        required_letters = {'n'}
        if not all(letter in word for letter in required_letters):
            continue

        # Certain letter cannot be at a specific position
        invalid_positions = [(3 , 'n')]
        if any(word[pos] == letter for pos, letter in invalid_positions):
            continue

        # Certain letter must be at a specific position
        required_positions = [(0, 's')]
        if not all(word[pos] == letter for pos, letter in required_positions):
            continue

        matchedList.append(word)

    # Count the occurrence of each letter in the words
    letter_count = {}
    # Iterate through the list of words, updating the count of each letter
    for word in matchedList:
        for letter in word:
            letter_count[letter] = letter_count.get(letter, 0) + 1
    # Print the letter count result
    print("Letter count:", letter_count)
    # How many different letters are there
    def unique_letter_count(word):
        return len(set(word))
    # Score each word
    def word_score(word, letter_count):
        return sum(letter_count.get(letter, 0) for letter in word)
    # Create a new list containing the original word and its score
    sortedWordList = [(word, word_score(word, letter_count)) for word in matchedList]
    # Sort the list by score in descending order
    sortedWordList.sort(key=lambda x: (unique_letter_count(x[0]), x[1]), reverse=True)

    print([word for word, score in sortedWordList[0:300]])
    print(f"Total number of matching words: {len(sortedWordList)}")

# common 10000 words source: https://www.mit.edu/~ecprice/wordlist.10000
with open('./common_words.txt', mode='r', encoding='utf-8') as fp:
    print("Filtered results from the common words list:")
    matchWord(fp)

print("=====================")
# all words source: https://www.keithv.com/software/wlist/
with open('./words.txt', mode='r', encoding='utf-8') as fp:
    print("Filtered results from the complete words list:")
    matchWord(fp)