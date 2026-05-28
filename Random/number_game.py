
import random

def guess_the_number():
    """
    A simple 'Guess the Number' game.
    The computer picks a random number, and the user tries to guess it.
    """
    print("Welcome to 'Guess the Number'!")
    print("I'm thinking of a number between 1 and 100.")
    print("Can you guess what it is?")

    # Generate a random number between 1 and 100
    secret_number = random.randint(1, 100)
    attempts = 0

    while True:
        try:
            guess = int(input("Enter your guess: "))
            attempts += 1

            if guess < 1 or guess > 100:
                print("Please guess a number between 1 and 100.")
            elif guess < secret_number:
                print("Too low! Try again.")
            elif guess > secret_number:
                print("Too high! Try again.")
            else:
                print(f"Congratulations! You guessed the number {secret_number} in {attempts} attempts!")
                break
        except ValueError:
            print("Invalid input. Please enter a whole number.")
        except KeyboardInterrupt:
            print("\nExiting the game. Goodbye!")
            break

if __name__ == "__main__":
    guess_the_number()
